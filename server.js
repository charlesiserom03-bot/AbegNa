'use strict';
/* Abegna back end: zero-dependency Node (>=22.13). HTTP + SQLite + secure sessions. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const scrypt = promisify(crypto.scrypt);

const PORT = +process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'abegna.db');
const MIN_AMT = 2000, MAX_AMT = 100000, WAIT_MS = 14 * 864e5, SESSION_MS = 30 * 864e5;

/* ---------- database ---------- */
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, role TEXT NOT NULL CHECK(role IN('requester','sponsor')),
  name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, hash TEXT NOT NULL,
  last_post_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS needs(
  id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL, name TEXT NOT NULL,
  loc TEXT NOT NULL, cat TEXT NOT NULL, amt INTEGER NOT NULL CHECK(amt BETWEEN ${MIN_AMT} AND ${MAX_AMT}),
  why TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','funded')),
  paid_by INTEGER REFERENCES users(id), paid_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS skips(user_id INTEGER NOT NULL, need_id INTEGER NOT NULL, PRIMARY KEY(user_id,need_id));
CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY, need_id INTEGER NOT NULL REFERENCES needs(id), sponsor_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL, reference TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_needs_status ON needs(status,created_at);
CREATE INDEX IF NOT EXISTS idx_needs_owner ON needs(owner_id);
`);
const q = {
  userByPhone: db.prepare('SELECT * FROM users WHERE phone=?'),
  userById: db.prepare('SELECT id,role,name,phone,last_post_at FROM users WHERE id=?'),
  insUser: db.prepare('INSERT INTO users(role,name,phone,salt,hash,created_at) VALUES(?,?,?,?,?,?)'),
  insSess: db.prepare('INSERT INTO sessions VALUES(?,?,?)'),
  getSess: db.prepare('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?'),
  delSess: db.prepare('DELETE FROM sessions WHERE token_hash=?'),
  purge: db.prepare('DELETE FROM sessions WHERE expires_at<=?'),
};

/* ---------- helpers ---------- */
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const json = (res, code, obj, extra = {}) => {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(b);
};
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (code, msg) => { throw new HttpError(code, msg); };
const clean = (s, min, max, label) => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (v.length < min || v.length > max) bad(400, `${label} must be ${min} to ${max} characters.`);
  return v;
};
const normPhone = p => {
  const v = String(p || '').replace(/[\s-]/g, '').replace(/^\+234/, '0');
  if (!/^0[789][01]\d{8}$/.test(v)) bad(400, 'Enter a valid Nigerian phone number.');
  return v;
};
const checkPassword = p => {
  p = String(p || '');
  if (p.length < 8 || p.length > 100 || !/[A-Za-z]/.test(p) || !/\d/.test(p))
    bad(400, 'Password must be at least 8 characters with a letter and a number.');
  return p;
};
const hashPw = async (pw, salt) => (await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 })).toString('hex');
const hits = new Map();
function limit(key, max, windowMs) {
  const now = Date.now(), h = hits.get(key);
  if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return; }
  if (++h.n > max) bad(429, 'Too many attempts. Please try again later.');
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.reset < n) hits.delete(k); q.purge.run(n); }, 6e4).unref();
const clientIp = req => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;

async function readBody(req) {
  if (!/^application\/json/i.test(req.headers['content-type'] || '')) bad(415, 'Send JSON.');
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 16384) bad(413, 'Request too large.'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { bad(400, 'Invalid JSON.'); }
}
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(a => a[0]).map(([k, ...v]) => [k, v.join('=')]));
const setCookie = (val, maxAge) => `abegna_sid=${val}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${PROD ? '; Secure' : ''}`;
function session(req) {
  const t = cookies(req).abegna_sid; if (!t) return null;
  const s = q.getSess.get(sha(t), Date.now());
  return s ? q.userById.get(s.user_id) : null;
}
function need(req, role) {
  const u = session(req); if (!u) bad(401, 'Please sign in.');
  if (role && u.role !== role) bad(403, `Only ${role}s can do this.`);
  return u;
}
async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.insSess.run(sha(token), userId, Date.now() + SESSION_MS);
  return setCookie(token, SESSION_MS / 1000);
}
const pubUser = u => ({ id: u.id, role: u.role, name: u.name, last_post_at: u.last_post_at, next_post_at: u.last_post_at ? u.last_post_at + WAIT_MS : 0 });
const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

/* ---------- payments (demo provider; swap for Paystack/Flutterwave) ---------- */
async function charge({ amount, need, sponsor }) {
  // TODO(live): initialize a Paystack/Flutterwave transaction, verify via webhook, then mark succeeded.
  return { provider: 'demo', reference: 'DEMO-' + crypto.randomBytes(6).toString('hex'), status: 'succeeded' };
}

/* ---------- API ---------- */
const routes = [];
const route = (m, p, fn) => routes.push([m, new RegExp('^' + p.replace(/:id/, '(\\d+)') + '$'), fn]);

route('POST', '/api/register', async (req, res) => {
  limit('reg:' + clientIp(req), 10, 36e5);
  const b = await readBody(req);
  const role = b.role === 'sponsor' ? 'sponsor' : b.role === 'requester' ? 'requester' : bad(400, 'Choose a role.');
  const name = clean(b.name, 2, 50, 'Name'), phone = normPhone(b.phone), pw = checkPassword(b.password);
  if (q.userByPhone.get(phone)) bad(409, 'This number is already registered.');
  const salt = crypto.randomBytes(16).toString('hex');
  const r = q.insUser.run(role, name, phone, salt, await hashPw(pw, salt), Date.now());
  const cookie = await startSession(res, Number(r.lastInsertRowid));
  json(res, 201, { user: pubUser(q.userById.get(Number(r.lastInsertRowid))) }, { 'Set-Cookie': cookie });
});
route('POST', '/api/login', async (req, res) => {
  limit('login:' + clientIp(req), 10, 9e5);
  const b = await readBody(req), phone = normPhone(b.phone), u = q.userByPhone.get(phone);
  const ok = u && crypto.timingSafeEqual(Buffer.from(await hashPw(String(b.password || ''), u.salt)), Buffer.from(u.hash));
  if (!ok) bad(401, 'Incorrect phone number or password.');
  if (u.role !== b.role) bad(403, `This number is registered as a ${u.role}. Switch above.`);
  json(res, 200, { user: pubUser(u) }, { 'Set-Cookie': await startSession(res, u.id) });
});
route('POST', '/api/logout', async (req, res) => {
  const t = cookies(req).abegna_sid; if (t) q.delSess.run(sha(t));
  json(res, 200, { ok: true }, { 'Set-Cookie': setCookie('', 0) });
});
route('GET', '/api/me', (req, res) => { const u = session(req); json(res, 200, { user: u ? pubUser(u) : null }); });

route('GET', '/api/feed', (req, res) => {
  const u = need(req, 'sponsor');
  json(res, 200, { needs: db.prepare(`SELECT id,name,loc,cat,amt,why FROM needs WHERE status='open' AND id NOT IN (SELECT need_id FROM skips WHERE user_id=?) ORDER BY created_at LIMIT 20`).all(u.id) });
});
route('POST', '/api/needs/:id/skip', (req, res, m) => {
  const u = need(req, 'sponsor'); db.prepare('INSERT OR IGNORE INTO skips VALUES(?,?)').run(u.id, +m[1]); json(res, 200, { ok: true });
});
route('POST', '/api/needs/:id/fund', async (req, res, m) => {
  const u = need(req, 'sponsor'), id = +m[1];
  const n = db.prepare('SELECT * FROM needs WHERE id=?').get(id);
  if (!n) bad(404, 'Request not found.');
  if (n.status !== 'open') bad(409, 'This request has already been funded.');
  const pay = await charge({ amount: n.amt, need: n, sponsor: u });
  if (pay.status !== 'succeeded') bad(402, 'Payment failed.');
  tx(() => {
    const r = db.prepare(`UPDATE needs SET status='funded',paid_by=?,paid_at=? WHERE id=? AND status='open'`).run(u.id, Date.now(), id);
    if (r.changes !== 1) bad(409, 'This request has already been funded.');
    db.prepare('INSERT INTO payments(need_id,sponsor_id,amount,reference,provider,status,created_at) VALUES(?,?,?,?,?,?,?)').run(id, u.id, n.amt, pay.reference, pay.provider, pay.status, Date.now());
  });
  json(res, 200, { ok: true, reference: pay.reference, amount: n.amt, name: n.name });
});
route('GET', '/api/activity', (req, res) => {
  const u = need(req, 'sponsor');
  const rows = db.prepare(`SELECT n.id,n.name,n.cat,n.amt,n.paid_at,p.reference FROM needs n JOIN payments p ON p.need_id=n.id WHERE n.paid_by=? ORDER BY n.paid_at DESC`).all(u.id);
  json(res, 200, { given: rows, total: rows.reduce((s, r) => s + r.amt, 0) });
});

route('POST', '/api/needs', async (req, res) => {
  const u = need(req, 'requester'), b = await readBody(req);
  const cats = ['School fees', 'Medical bills', 'Rent', 'Food', 'Business capital', 'Other'];
  const amt = Number(b.amt), loc = clean(b.loc, 2, 40, 'Location'), why = clean(b.why, 20, 400, 'Reason');
  if (!cats.includes(b.cat)) bad(400, 'Choose a category.');
  if (!Number.isInteger(amt) || amt < MIN_AMT || amt > MAX_AMT) bad(400, 'Amount must be between ₦2,000 and ₦100,000.');
  const out = tx(() => {
    const last = q.userById.get(u.id).last_post_at, now = Date.now();
    if (now - last < WAIT_MS) throw Object.assign(new HttpError(429, 'You can only post one request every 2 weeks.'), { next: last + WAIT_MS });
    const r = db.prepare('INSERT INTO needs(owner_id,name,loc,cat,amt,why,created_at) VALUES(?,?,?,?,?,?,?)').run(u.id, u.name, loc, b.cat, amt, why, now);
    db.prepare('UPDATE users SET last_post_at=? WHERE id=?').run(now, u.id);
    return { id: Number(r.lastInsertRowid), next_post_at: now + WAIT_MS };
  });
  json(res, 201, out);
});
route('GET', '/api/needs/mine', (req, res) => {
  const u = need(req, 'requester');
  json(res, 200, { needs: db.prepare('SELECT id,loc,cat,amt,status,created_at,paid_at FROM needs WHERE owner_id=? ORDER BY created_at DESC').all(u.id), user: pubUser(q.userById.get(u.id)) });
});

/* ---------- static files + server ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const SEC = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
  ...(PROD ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
};
const FILES = new Set(['index.html', 'style.css', 'app.js']); // only these are public
function serveStatic(req, res, pathname) {
  const name = pathname.replace(/^\//, '');
  const f = path.join(__dirname, FILES.has(name) ? name : 'index.html');
  const ext = path.extname(f);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
  fs.createReadStream(f).pipe(res);
}
const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEC)) res.setHeader(k, v);
  try {
    const { pathname } = new URL(req.url, 'http://x');
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') bad(405, 'Method not allowed.');
      return serveStatic(req, res, decodeURIComponent(pathname));
    }
    if (req.method !== 'GET') {
      const o = req.headers.origin; // CSRF defence on top of SameSite=Lax
      if (o && new URL(o).host !== req.headers.host) bad(403, 'Cross-site request blocked.');
    }
    for (const [m, re, fn] of routes) {
      const mt = re.exec(pathname);
      if (m === req.method && mt) return await fn(req, res, mt);
    }
    bad(404, 'Not found.');
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.code, { error: e.message, ...(e.next ? { next_post_at: e.next } : {}) });
    console.error(e); json(res, 500, { error: 'Something went wrong. Please try again.' });
  }
});

/* ---------- optional demo seed ---------- */
if (process.env.SEED === '1' && !db.prepare('SELECT 1 FROM needs LIMIT 1').get()) {
  const ins = db.prepare('INSERT INTO needs(owner_id,name,loc,cat,amt,why,created_at) VALUES(NULL,?,?,?,?,?,?)'); let t = Date.now();
  [['Chioma Okafor', 'Enugu, Enugu', 'School fees', 45000, 'I am in my final year of nursing school. I owe the balance of my fees and may not sit my exams without it.'],
   ['Tunde Adeyemi', 'Ibadan, Oyo', 'Business capital', 30000, 'I sell roasted corn but my grill broke. I need a new one and charcoal to resume work.'],
   ['Aisha Bello', 'Kano, Kano', 'Medical bills', 80000, 'My mother needs a minor surgery at the general hospital. We have raised half and need the rest.'],
   ['Emeka Nwosu', 'Aba, Abia', 'Rent', 20000, 'I lost my job last month and my landlord has given me a week to pay part of my rent.'],
   ['Blessing Udo', 'Uyo, Akwa Ibom', 'School fees', 12000, 'I am a single mother. My son’s school fees for this term are due and he has been sent home.']]
    .forEach(r => ins.run(...r, t++));
  console.log('Seeded demo requests.');
}
if (require.main === module) server.listen(PORT, () => console.log(`Abegna running on http://localhost:${PORT}`));
module.exports = { server };
