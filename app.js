'use strict';
const $ = s => document.querySelector(s);
const IC = { x: "M6 6l12 12M18 6L6 18", check: "M5 12.5l4.5 4.5L19 7", list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01", compass: "M12 21a9 9 0 100-18 9 9 0 000 18zM15.5 8.5l-2 5-5 2 2-5z", out: "M15 17l5-5-5-5M20 12H9M12 21H5a1 1 0 01-1-1V4a1 1 0 011-1h7", edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" };
const ic = n => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${IC[n]}"/></svg>`;
const N = n => "₦" + Number(n).toLocaleString("en-NG");
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const toast = m => { const t = $("#t"); t.textContent = m; t.classList.add("on"); setTimeout(() => t.classList.remove("on"), 2600) };
async function api(path, method = "GET", body) {
  const r = await fetch("/api" + path, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || "Request failed."), { status: r.status, data: d });
  return d;
}
let U = null, role = "requester", mode = "in", tab = null, cur = null, feed = [];

function auth() {
  const R = role === "requester", su = mode === "up";
  $("#app").innerHTML = `<div class="auth"><section class="hero"><div class="logo">Abeg<i>na</i></div><div><h1>${R ? "Ask for help with dignity." : "Give where it matters most."}</h1><p>${R ? "Share one genuine need every two weeks, from ₦2,000 to ₦100,000. Sponsors review your request and choose whether to fund it." : "Browse real needs from Nigerians across the country. Swipe to fund a request in full, or pass and keep looking."}</p></div><small>Abegna · Made for Nigeria</small></section>
 <section class="panel"><form class="box" id="af" novalidate><div class="seg"><button type="button" data-r="requester" class="${R ? "on" : ""}">Requester</button><button type="button" data-r="sponsor" class="${R ? "" : "on"}">Sponsor</button></div>
 <h2 style="margin:4px 0 0">${su ? "Create your account" : "Welcome back"}</h2><div class="note">${R ? "Requester" : "Sponsor"} ${su ? "registration" : "sign in"}</div>
 ${su ? `<label>Full name<input id="an" required maxlength="50" autocomplete="name"></label>` : ""}
 <label>Phone number<input id="ap" required inputmode="tel" placeholder="0803 000 0000" autocomplete="tel"></label>
 <label>Password<input id="aw" type="password" required autocomplete="${su ? "new-password" : "current-password"}">${su ? '<span class="hint">At least 8 characters, with a letter and a number.</span>' : ""}</label>
 <div class="err" id="ae" role="alert"></div><button class="btn" id="ab">${su ? "Create account" : "Sign in"}</button>
 <div class="note">${su ? "Already registered?" : "New here?"} <button type="button" class="link" id="sw">${su ? "Sign in" : "Create an account"}</button></div></form></section></div>`;
  document.querySelectorAll(".seg button").forEach(b => b.onclick = () => { role = b.dataset.r; auth() });
  $("#sw").onclick = () => { mode = su ? "in" : "up"; auth() };
  $("#af").onsubmit = async e => {
    e.preventDefault(); const E = $("#ae"), B = $("#ab"); E.textContent = ""; B.classList.add("busy");
    try {
      const body = { role, phone: $("#ap").value, password: $("#aw").value }; if (su) body.name = $("#an").value;
      U = (await api(su ? "/register" : "/login", "POST", body)).user; tab = null; shell();
    } catch (er) { E.textContent = er.message } finally { B.classList.remove("busy") }
  };
}
function shell() {
  if (!U) return auth();
  const R = U.role === "requester";
  const tabs = R ? [["post", "edit", "Post a need"], ["mine", "list", "My requests"]] : [["disc", "compass", "Discover"], ["act", "list", "Activity"]];
  if (!tab) tab = tabs[0][0];
  $("#app").innerHTML = `<header class="top"><div class="logo">Abeg<i>na</i></div><div class="r"><span class="badge">${U.role}</span><span class="hide-s">${esc(U.name)}</span><button class="btn ghost" id="lo">${ic("out")}<span class="hide-s">Sign out</span></button></div></header>
 <nav class="tabs">${tabs.map(t => `<button data-t="${t[0]}" class="${tab === t[0] ? "on" : ""}">${ic(t[1])}${t[2]}</button>`).join("")}</nav><main id="v"></main>`;
  $("#lo").onclick = async () => { try { await api("/logout", "POST", {}) } catch { } U = null; auth() };
  document.querySelectorAll("nav.tabs button").forEach(b => b.onclick = () => { tab = b.dataset.t; shell() });
  ({ post: vPost, mine: vMine, disc: vDisc, act: vAct })[tab]().catch(handle);
}
function handle(e) { if (e.status === 401) { U = null; toast("Session expired. Please sign in."); auth() } else toast(e.message) }

async function vDisc() {
  $("#v").innerHTML = `<h2 style="margin:0">Discover</h2><p class="sub">Swipe right to fund a request. Swipe left to pass.</p><div class="stage" id="st"></div>
 <div class="acts"><button id="sk" aria-label="Pass">${ic("x")}</button><button class="y" id="py" aria-label="Fund">${ic("check")}</button></div>`;
  $("#sk").onclick = () => { if (feed[0]) skip(feed[0].id) }; $("#py").onclick = () => { if (feed[0]) ask(feed[0].id) };
  feed = (await api("/feed")).needs; cards();
}
function cards() {
  const st = $("#st"); if (!st) return;
  if (!feed.length) { st.innerHTML = `<div class="empty"><h3>You’re all caught up</h3>New requests will appear here.</div>`; return }
  st.innerHTML = feed.slice(0, 3).reverse().map(n => `<div class="card" data-id="${n.id}"><div class="stamp pay">FUND</div><div class="stamp skip">PASS</div><div class="cat">${esc(n.cat)}</div><div class="amt">${N(n.amt)}</div><hr class="rule"><div><div class="who">${esc(n.name)}</div><div class="loc">${esc(n.loc)}</div></div><div class="why">${esc(n.why)}</div></div>`).join("");
  bind(st.lastElementChild);
}
function bind(c) {
  let x0 = 0, dx = 0, on = false; const p = c.querySelector(".pay"), k = c.querySelector(".skip");
  c.onpointerdown = e => { on = true; x0 = e.clientX; c.classList.add("drag"); c.setPointerCapture(e.pointerId) };
  c.onpointermove = e => { if (!on) return; dx = e.clientX - x0; c.style.transform = `translateX(${dx}px) rotate(${dx / 25}deg)`; p.style.opacity = Math.max(0, dx / 120); k.style.opacity = Math.max(0, -dx / 120) };
  c.onpointerup = () => { if (!on) return; on = false; c.classList.remove("drag"); const id = +c.dataset.id; if (dx > 110) ask(id); else if (dx < -110) skip(id); else { c.style.transform = ""; p.style.opacity = k.style.opacity = 0 } dx = 0 };
}
async function skip(id) { feed = feed.filter(n => n.id !== id); cards(); try { await api(`/needs/${id}/skip`, "POST", {}) } catch (e) { handle(e) } }
function ask(id) { cur = feed.find(n => n.id === id); $("#mt").textContent = `Fund ${N(cur.amt)} for ${cur.name}?`; $("#m").classList.add("on"); cards() }
$("#cx").onclick = () => { $("#m").classList.remove("on"); cur = null; cards() };
$("#ok").onclick = async () => {
  const n = cur, B = $("#ok"); B.classList.add("busy");
  try { await api(`/needs/${n.id}/fund`, "POST", {}); feed = feed.filter(x => x.id !== n.id); toast(`${N(n.amt)} sent to ${n.name.split(" ")[0]}`) }
  catch (e) { if (e.status === 409) feed = feed.filter(x => x.id !== n.id); handle(e) }
  finally { B.classList.remove("busy"); $("#m").classList.remove("on"); cur = null; cards() }
};
async function vAct() {
  const d = await api("/activity");
  $("#v").innerHTML = `<h2 style="margin:0">Activity</h2><p class="sub">Your giving history.</p><div class="stats"><div class="stat"><span class="note">Total given</span><b>${N(d.total)}</b></div><div class="stat"><span class="note">People supported</span><b>${d.given.length}</b></div></div>
 <div class="list">${d.given.map(n => `<div class="row"><span><b>${esc(n.name)}</b><br><span class="note">${esc(n.cat)} · ${new Date(n.paid_at).toLocaleDateString("en-NG")} · ${esc(n.reference)}</span></span><b>${N(n.amt)}</b></div>`).join("") || '<div class="empty">No contributions yet.</div>'}</div>`;
}
async function vPost() {
  const me = (await api("/me")).user; U = me; const left = me.next_post_at - Date.now(), lock = left > 0;
  $("#v").innerHTML = `<h2 style="margin:0">Post a need</h2><p class="sub">One request every 2 weeks. Amount: ₦2,000 to ₦100,000.</p>
 <form class="f" id="pf" novalidate><label>City and state<input id="pl" required maxlength="40" placeholder="e.g. Ibadan, Oyo"></label>
 <label>Category<select id="pc"><option>School fees</option><option>Medical bills</option><option>Rent</option><option>Food</option><option>Business capital</option><option>Other</option></select></label>
 <label>Amount (₦)<input id="pa" type="number" inputmode="numeric" min="2000" max="100000" step="500" required></label>
 <label>Your reason<textarea id="pr" rows="4" required maxlength="400"></textarea><span class="hint">At least 20 characters. Be specific and honest.</span></label>
 <div class="err" id="pe" role="alert"></div><button class="btn" id="pb" ${lock ? "disabled" : ""}>Submit request</button>
 <div class="note">${lock ? `You can post again in ${Math.ceil(left / 864e5)} day(s).` : "You can post one request now."}</div></form>`;
  $("#pf").onsubmit = async e => {
    e.preventDefault(); const B = $("#pb"); B.classList.add("busy"); $("#pe").textContent = "";
    try { await api("/needs", "POST", { loc: $("#pl").value, cat: $("#pc").value, amt: +$("#pa").value, why: $("#pr").value }); toast("Your request is live"); tab = "mine"; shell() }
    catch (er) { $("#pe").textContent = er.message } finally { B.classList.remove("busy") }
  };
}
async function vMine() {
  const d = await api("/needs/mine");
  $("#v").innerHTML = `<h2 style="margin:0">My requests</h2><p class="sub">Track the status of what you have posted.</p><div class="list">${d.needs.map(n => `<div class="row"><span><b>${N(n.amt)}</b> · ${esc(n.cat)}<br><span class="note">${esc(n.loc)}</span></span><span class="pill ${n.status === "funded" ? "ok" : ""}">${n.status === "funded" ? "Funded" : "Open"}</span></div>`).join("") || '<div class="empty">You have not posted a request yet.</div>'}</div>`;
}
(async () => { try { U = (await api("/me")).user } catch { } shell() })();
