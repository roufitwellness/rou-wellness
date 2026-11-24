// Cloudflare Worker：學員回饋（先存「待審核」，Rou 確認後才公開）與學員預約（老師開時段、學員憑預約碼選時段）。其他網址交給靜態網站。
const SCHEMA = `CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  ip_hash TEXT
)`;
const BOOKING_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  minutes INTEGER NOT NULL DEFAULT 60,
  capacity INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS slots_start ON slots (starts_at)`,
  `CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'booked',
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  cancelled_at TEXT,
  ip_hash TEXT
)`,
  `CREATE INDEX IF NOT EXISTS bookings_slot ON bookings (slot_id, status)`,
  `CREATE TABLE IF NOT EXISTS code_fail (ip_hash TEXT NOT NULL, at TEXT NOT NULL)`,
];
let ready = null;
async function init(env) {
  if (!ready) {
    const stmts = [SCHEMA, ...BOOKING_SCHEMA].map((q) => env.DB.prepare(q));
    ready = env.DB.batch(stmts).catch((e) => { ready = null; throw e; });
  }
  await ready;
}

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...extra } });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function authed(req, env) {
  if (!env.ADMIN_PASSWORD) return "missing";
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  let pass = "";
  try {
    const raw = atob(h.slice(6));
    pass = new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0)));
    pass = pass.slice(pass.indexOf(":") + 1);
  } catch { return false; }
  return safeEqual(pass, env.ADMIN_PASSWORD);
}

function needAuth(state) {
  if (state === "missing") return new Response("管理密碼還沒有設定。", { status: 503 });
  return new Response("需要密碼", { status: 401, headers: { "www-authenticate": 'Basic realm="Rou Wellness Admin", charset="UTF-8"' } });
}

async function submit(req, env) {
  let data;
  try { data = await req.json(); } catch { return json({ ok: false, error: "格式不正確" }, 400); }
  if (data.hp) return json({ ok: true }); // 機器人欄位被填寫：假裝成功
  const name = String(data.name || "").trim().slice(0, 20) || "學員";
  const message = String(data.message || "").trim();
  if (message.length < 5) return json({ ok: false, error: "再多寫幾個字吧" }, 400);
  if (message.length > 600) return json({ ok: false, error: "字數有點多，請縮短在 600 字內" }, 400);
  await init(env);
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  const ipHash = await sha256("rou:" + ip);
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE ip_hash = ? AND created_at > ?").bind(ipHash, since).first();
  if (recent && recent.n >= 3) return json({ ok: false, error: "送出太頻繁，請稍後再試" }, 429);
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE status = 'pending'").first();
  if (pending && pending.n >= 300) return json({ ok: false, error: "目前暫時無法送出" }, 503);
  await env.DB.prepare("INSERT INTO feedback (name, message, status, created_at, ip_hash) VALUES (?, ?, 'pending', ?, ?)")
    .bind(name, message, new Date().toISOString(), ipHash).run();
  return json({ ok: true });
}

async function listApproved(env) {
  await init(env);
  const { results } = await env.DB.prepare("SELECT name, message FROM feedback WHERE status = 'approved' ORDER BY id DESC LIMIT 50").all();
  return json({ items: results || [] }, 200, { "cache-control": "public, max-age=60" });
}

const LABEL = { pending: "待確認", approved: "公開中", hidden: "已隱藏" };

async function adminPage(env) {
  await init(env);
  const { results } = await env.DB.prepare("SELECT id, name, message, status, created_at FROM feedback ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, id DESC LIMIT 300").all();
  const rows = (results || []).map((r) => {
    const btns = r.status === "approved"
      ? `<button data-a="hide" data-id="${r.id}">取消公開</button>`
      : `<button class="go" data-a="approve" data-id="${r.id}">公開</button>`;
    return `<article class="s-${r.status}"><div class="top"><span class="tag">${LABEL[r.status] || r.status}</span><span class="when">${esc(r.created_at.slice(0, 10))}</span></div>
<p class="msg">${esc(r.message)}</p><p class="who">— ${esc(r.name)}</p>
<div class="btns">${btns}<button class="del" data-a="delete" data-id="${r.id}">刪除</button></div></article>`;
  }).join("") || "<p>目前還沒有回饋。</p>";
  const html = `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>回饋管理</title>
<style>body{margin:0;background:#FAF4F1;color:#554F49;font:16px/1.8 "Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif}main{max-width:640px;margin:0 auto;padding:24px 16px 60px}${NAV_CSS}h1{font-size:22px;margin:0 0 4px}.hint{color:#736861;font-size:14px;margin:0 0 20px}
article{background:#fff;border:1px solid #EBD7D9;border-radius:16px;padding:16px 18px;margin-bottom:14px}.s-pending{border-color:#A25D69}.top{display:flex;justify-content:space-between;font-size:13px;color:#736861}.tag{color:#A25D69}.msg{margin:8px 0 2px;white-space:pre-wrap;word-break:break-word}.who{margin:0;color:#736861;font-size:14px}
.btns{display:flex;gap:10px;margin-top:12px}button{font:inherit;font-size:14px;padding:6px 16px;border-radius:999px;border:1px solid #A25D69;background:#fff;color:#A25D69}button.go{background:#A25D69;color:#fff}button.del{border-color:#C9B8B0;color:#736861}</style></head>
<body><main>${ADMIN_NAV("fb")}<h1>學員回饋管理</h1><p class="hint">只有按「公開」的回饋會顯示在網站上。這個頁面不會被搜尋到。</p>${rows}</main>
<script>document.addEventListener("click",async e=>{const b=e.target.closest("button[data-a]");if(!b)return;if(b.dataset.a==="delete"&&!confirm("確定要刪除這則回饋嗎？"))return;b.disabled=true;
const r=await fetch("/admin/action",{method:"POST",headers:{"content-type":"application/json","x-requested-with":"admin"},body:JSON.stringify({id:Number(b.dataset.id),action:b.dataset.a})});if(r.ok)location.reload();else{alert("失敗了，請再試一次");b.disabled=false}});</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

async function adminAction(req, env, url) {
  if (req.headers.get("x-requested-with") !== "admin") return json({ ok: false }, 403);
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== url.host) return json({ ok: false }, 403);
  let d; try { d = await req.json(); } catch { return json({ ok: false }, 400); }
  const id = Number(d.id);
  if (!Number.isInteger(id)) return json({ ok: false }, 400);
  await init(env);
  if (d.action === "approve") await env.DB.prepare("UPDATE feedback SET status = 'approved' WHERE id = ?").bind(id).run();
  else if (d.action === "hide") await env.DB.prepare("UPDATE feedback SET status = 'hidden' WHERE id = ?").bind(id).run();
  else if (d.action === "delete") await env.DB.prepare("DELETE FROM feedback WHERE id = ?").bind(id).run();
  else return json({ ok: false }, 400);
  return json({ ok: true });
}

// ---------------- 學員預約 ----------------
// 服務項目與預設人數上限（管理頁新增時段時可以再改人數）
const SERVICES = { "一對一皮拉提斯": 1, "小團體皮拉提斯": 4 };
const BOOK_BEFORE_HOURS = 12; // 開課前幾小時停止線上預約
const CANCEL_BEFORE_HOURS = 24; // 開課前幾小時內不能線上取消（請直接傳訊息給老師）

const ADMIN_NAV = (on) => `<nav class="anav"><a href="/admin"${on === "fb" ? ' class="on"' : ""}>回饋管理</a><a href="/admin/booking"${on === "bk" ? ' class="on"' : ""}>預約管理</a></nav>`;
const NAV_CSS = `.anav{display:flex;gap:8px;margin:0 0 18px}.anav a{padding:4px 14px;border-radius:999px;border:1px solid #EBD7D9;color:#736861;text-decoration:none;font-size:14px}.anav a.on{background:#A25D69;border-color:#A25D69;color:#fff}`;

// 台灣時間，格式 "YYYY-MM-DD HH:MM"，字串可以直接比大小
const twNow = (plusHours = 0) => new Date(Date.now() + (8 + plusHours) * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
const WEEK = "日一二三四五六";
function zhWhen(startsAt, minutes) {
  const [d, t] = startsAt.split(" ");
  const [y, m, day] = d.split("-").map(Number);
  const wd = WEEK[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
  const [hh, mm] = t.split(":").map(Number);
  const end = hh * 60 + mm + minutes;
  const endT = `${String(Math.floor(end / 60) % 24).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
  return `${m}月${day}日（${wd}）${t}–${endT}`;
}
function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_");
}

async function checkCode(req, env) {
  if (!env.BOOKING_CODE) return json({ ok: false, error: "線上預約還沒有開放。" }, 503);
  await init(env);
  const ipHash = await sha256("rou:" + (req.headers.get("cf-connecting-ip") || "unknown"));
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const fails = await env.DB.prepare("SELECT COUNT(*) AS n FROM code_fail WHERE ip_hash = ? AND at > ?").bind(ipHash, since).first();
  if (fails && fails.n >= 10) return json({ ok: false, error: "嘗試太多次，請一小時後再試。" }, 429);
  const code = (req.headers.get("x-booking-code") || "").trim();
  if (!code || !safeEqual(code.toLowerCase(), String(env.BOOKING_CODE).trim().toLowerCase())) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO code_fail (ip_hash, at) VALUES (?, ?)").bind(ipHash, new Date().toISOString()),
      env.DB.prepare("DELETE FROM code_fail WHERE at < ?").bind(new Date(Date.now() - 86400 * 1000).toISOString()),
    ]);
    return json({ ok: false, error: "預約碼不正確，請向老師確認。", badCode: true }, 403);
  }
  return { ipHash };
}

async function listSlots(env) {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.service, s.starts_at, s.minutes, s.capacity,
       (SELECT COUNT(*) FROM bookings b WHERE b.slot_id = s.id AND b.status = 'booked') AS taken
     FROM slots s WHERE s.status = 'open' AND s.starts_at > ? ORDER BY s.starts_at LIMIT 200`
  ).bind(twNow(BOOK_BEFORE_HOURS)).all();
  const items = (results || []).map((r) => ({
    id: r.id, service: r.service, date: r.starts_at.slice(0, 10), when: zhWhen(r.starts_at, r.minutes),
    left: Math.max(0, r.capacity - r.taken),
  }));
  return json({ ok: true, items, bookBeforeHours: BOOK_BEFORE_HOURS, cancelBeforeHours: CANCEL_BEFORE_HOURS }, 200, { "cache-control": "no-store" });
}

async function book(req, env, ipHash) {
  let d; try { d = await req.json(); } catch { return json({ ok: false, error: "格式不正確" }, 400); }
  if (d.hp) return json({ ok: false, error: "送出失敗，請稍後再試。" }, 400);
  const slotId = Number(d.slot_id);
  const name = String(d.name || "").trim().slice(0, 30);
  const contact = String(d.contact || "").trim().slice(0, 60);
  const note = String(d.note || "").trim().slice(0, 300);
  if (!Number.isInteger(slotId)) return json({ ok: false, error: "請先選擇時段" }, 400);
  if (!name) return json({ ok: false, error: "請填寫姓名" }, 400);
  if (contact.length < 3) return json({ ok: false, error: "請填寫聯絡方式（電話、LINE 或 IG 帳號）" }, 400);
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE ip_hash = ? AND created_at > ?").bind(ipHash, since).first();
  if (recent && recent.n >= 6) return json({ ok: false, error: "預約太頻繁，請稍後再試" }, 429);
  const dup = await env.DB.prepare("SELECT id FROM bookings WHERE slot_id = ? AND status = 'booked' AND lower(contact) = lower(?)").bind(slotId, contact).first();
  if (dup) return json({ ok: false, error: "你已經預約過這個時段了" }, 409);
  const token = randomToken();
  // 一個指令內同時檢查「時段開放、還沒截止、還有名額」，避免兩個人同時搶到最後一個位子
  const r = await env.DB.prepare(
    `INSERT INTO bookings (slot_id, name, contact, note, status, token, created_at, ip_hash)
     SELECT s.id, ?, ?, ?, 'booked', ?, ?, ? FROM slots s
     WHERE s.id = ? AND s.status = 'open' AND s.starts_at > ?
       AND (SELECT COUNT(*) FROM bookings b WHERE b.slot_id = s.id AND b.status = 'booked') < s.capacity`
  ).bind(name, contact, note, token, new Date().toISOString(), ipHash, slotId, twNow(BOOK_BEFORE_HOURS)).run();
  if (!r.meta || r.meta.changes !== 1) return json({ ok: false, error: "這個時段剛好額滿或已關閉，請選其他時段。", full: true }, 409);
  const s = await env.DB.prepare("SELECT service, starts_at, minutes FROM slots WHERE id = ?").bind(slotId).first();
  return json({ ok: true, token, service: s.service, when: zhWhen(s.starts_at, s.minutes), name });
}

async function bookingByToken(env, token) {
  if (!token || token.length < 20 || token.length > 40) return null;
  await init(env);
  return env.DB.prepare(
    `SELECT b.id, b.name, b.status, s.service, s.starts_at, s.minutes FROM bookings b JOIN slots s ON s.id = b.slot_id WHERE b.token = ?`
  ).bind(token).first();
}

async function cancelInfo(env, url) {
  const b = await bookingByToken(env, url.searchParams.get("t") || "");
  if (!b) return json({ ok: false, error: "找不到這筆預約，連結可能不完整。" }, 404);
  const canCancel = b.status === "booked" && b.starts_at > twNow(CANCEL_BEFORE_HOURS);
  return json({ ok: true, name: b.name, service: b.service, when: zhWhen(b.starts_at, b.minutes), status: b.status, canCancel, cancelBeforeHours: CANCEL_BEFORE_HOURS }, 200, { "cache-control": "no-store" });
}

async function cancelBooking(req, env) {
  let d; try { d = await req.json(); } catch { return json({ ok: false, error: "格式不正確" }, 400); }
  const b = await bookingByToken(env, String(d.token || ""));
  if (!b) return json({ ok: false, error: "找不到這筆預約。" }, 404);
  if (b.status !== "booked") return json({ ok: true });
  if (b.starts_at <= twNow(CANCEL_BEFORE_HOURS)) return json({ ok: false, error: `開課前 ${CANCEL_BEFORE_HOURS} 小時內無法線上取消，請直接傳訊息給老師。` }, 409);
  await env.DB.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'booked'").bind(new Date().toISOString(), b.id).run();
  return json({ ok: true });
}

async function bookingAdminPage(env, url) {
  await init(env);
  const past = url.searchParams.get("past") === "1";
  const today = twNow().slice(0, 10);
  const q = past
    ? "SELECT * FROM slots WHERE starts_at < ? ORDER BY starts_at DESC LIMIT 200"
    : "SELECT * FROM slots WHERE starts_at >= ? ORDER BY starts_at LIMIT 300";
  const { results: slots } = await env.DB.prepare(q).bind(today).all();
  const ids = (slots || []).map((s) => s.id);
  const bySlot = {};
  if (ids.length) {
    const { results: bs } = await env.DB.prepare(
      `SELECT id, slot_id, name, contact, note, status, created_at FROM bookings WHERE slot_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`
    ).bind(...ids).all();
    for (const b of bs || []) (bySlot[b.slot_id] ||= []).push(b);
  }
  let lastDate = "";
  const cards = (slots || []).map((s) => {
    const bs = bySlot[s.id] || [];
    const active = bs.filter((b) => b.status === "booked");
    const head = s.starts_at.slice(0, 10) !== lastDate ? `<h2 class="day">${esc(zhWhen(s.starts_at, s.minutes).split("）")[0])}）</h2>` : "";
    lastDate = s.starts_at.slice(0, 10);
    const people = bs.map((b) => `<li class="b-${b.status}"><div><b>${esc(b.name)}</b>　${esc(b.contact)}${b.status === "cancelled" ? '　<span class="x">已取消</span>' : ""}
${b.note ? `<div class="note">${esc(b.note)}</div>` : ""}</div>${b.status === "booked" ? `<button class="del" data-a="cancel-booking" data-id="${b.id}">取消</button>` : ""}</li>`).join("");
    const full = active.length >= s.capacity;
    const state = s.status === "closed" ? '<span class="tag closed">已關閉</span>' : full ? '<span class="tag full">額滿</span>' : '<span class="tag">開放中</span>';
    const toggle = s.status === "closed"
      ? `<button class="go" data-a="open" data-id="${s.id}">重新開放</button>`
      : `<button data-a="close" data-id="${s.id}">關閉時段</button>`;
    return `${head}<article class="${s.status === "closed" ? "s-closed" : ""}"><div class="top"><span><b>${esc(zhWhen(s.starts_at, s.minutes).split("）")[1])}</b>　${esc(s.service)}</span>${state}</div>
<p class="cnt">已預約 ${active.length} / ${s.capacity} 人</p>${people ? `<ul>${people}</ul>` : ""}
<div class="btns">${toggle}<button class="del" data-a="delete" data-id="${s.id}" data-n="${active.length}">刪除</button></div></article>`;
  }).join("") || `<p class="hint">${past ? "沒有過去的時段。" : "還沒有開放的時段，用上面的表單新增吧。"}</p>`;
  const svcOpts = Object.entries(SERVICES).map(([n, c]) => `<option value="${esc(n)}" data-cap="${c}">${esc(n)}</option>`).join("");
  const codeHint = env.BOOKING_CODE ? "" : '<p class="warn">⚠️ 還沒有設定學員預約碼（BOOKING_CODE），學員目前無法預約。</p>';
  const html = `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>預約管理</title>
<style>body{margin:0;background:#FAF4F1;color:#554F49;font:16px/1.8 "Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif}main{max-width:680px;margin:0 auto;padding:24px 16px 60px}${NAV_CSS}h1{font-size:22px;margin:0 0 4px}.hint{color:#736861;font-size:14px;margin:0 0 20px}.warn{background:#FCEBDD;border-radius:12px;padding:8px 14px;font-size:14px}
form.add{background:#fff;border:1px solid #EBD7D9;border-radius:16px;padding:16px 18px;margin:0 0 24px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}form.add h2{grid-column:1/-1;font-size:17px;margin:0}form.add label{display:grid;gap:4px;font-size:14px;color:#736861}form.add .full{grid-column:1/-1}
input,select{font:inherit;color:#554F49;background:#fff;border:1px solid #EBD7D9;border-radius:10px;padding:7px 10px;min-width:0}
.tabs{display:flex;gap:14px;font-size:14px;margin:0 0 8px}.tabs a{color:#736861}.tabs a.on{color:#A25D69;font-weight:500}
h2.day{font-size:16px;margin:26px 0 8px;color:#A25D69}
article{background:#fff;border:1px solid #EBD7D9;border-radius:16px;padding:14px 18px;margin-bottom:12px}.s-closed{opacity:.65}.top{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.tag{font-size:13px;color:#2F6F5E}.tag.full{color:#A25D69}.tag.closed{color:#736861}.cnt{margin:2px 0;font-size:14px;color:#736861}
ul{list-style:none;margin:8px 0 0;padding:0}li{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:8px 0;border-top:1px dashed #EBD7D9;word-break:break-word}li.b-cancelled{color:#A99D96}.x{font-size:13px}.note{font-size:14px;color:#736861;white-space:pre-wrap}
.btns{display:flex;gap:10px;margin-top:10px}button{font:inherit;font-size:14px;padding:5px 14px;border-radius:999px;border:1px solid #A25D69;background:#fff;color:#A25D69;cursor:pointer;white-space:nowrap}button.go{background:#A25D69;color:#fff}button.del{border-color:#C9B8B0;color:#736861}
@media (max-width:520px){form.add{grid-template-columns:1fr}}</style></head>
<body><main>${ADMIN_NAV("bk")}<h1>學員預約管理</h1><p class="hint">在這裡開放時段，學員輸入預約碼後就能在 <a href="/booking/">/booking/</a> 頁面選時段。開課前 ${BOOK_BEFORE_HOURS} 小時停止線上預約，${CANCEL_BEFORE_HOURS} 小時內學員不能自行取消。</p>${codeHint}
<form class="add" id="add"><h2>新增時段</h2>
<label class="full">服務<select name="service">${svcOpts}</select></label>
<label>日期<input type="date" name="date" required min="${today}"></label>
<label>開始時間<input type="time" name="time" required step="300"></label>
<label>課程長度（分鐘）<input type="number" name="minutes" value="60" min="15" max="240" step="5" required></label>
<label>人數上限<input type="number" name="capacity" value="1" min="1" max="20" required></label>
<label class="full">每週重複<select name="weeks"><option value="1">只有這一次</option>${[2, 4, 8, 12].map((n) => `<option value="${n}">連續 ${n} 週（同一天同時間）</option>`).join("")}</select></label>
<div class="full"><button class="go" type="submit">新增時段</button></div></form>
<div class="tabs"><a href="/admin/booking"${past ? "" : ' class="on"'}>今天以後</a><a href="/admin/booking?past=1"${past ? ' class="on"' : ""}>過去的時段</a></div>
${cards}</main>
<script>
const f=document.getElementById("add");
f.service.addEventListener("change",()=>{f.capacity.value=f.service.selectedOptions[0].dataset.cap});
async function send(body){const r=await fetch("/admin/booking/action",{method:"POST",headers:{"content-type":"application/json","x-requested-with":"admin"},body:JSON.stringify(body)});let j={};try{j=await r.json()}catch{}if(r.ok&&j.ok)location.reload();else alert(j.error||"失敗了，請再試一次");}
f.addEventListener("submit",async e=>{e.preventDefault();const b=f.querySelector("button");b.disabled=true;
await send({action:"add",service:f.service.value,date:f.date.value,time:f.time.value,minutes:Number(f.minutes.value),capacity:Number(f.capacity.value),weeks:Number(f.weeks.value)});b.disabled=false});
document.addEventListener("click",async e=>{const b=e.target.closest("button[data-a]");if(!b)return;const a=b.dataset.a;
if(a==="delete"&&!confirm(Number(b.dataset.n)>0?"這個時段還有學員預約，刪除後預約紀錄也會一起刪掉。確定嗎？（建議先聯絡學員）":"確定要刪除這個時段嗎？"))return;
if(a==="cancel-booking"&&!confirm("確定要取消這位學員的預約嗎？記得另外通知學員。"))return;
b.disabled=true;await send({action:a,id:Number(b.dataset.id)});b.disabled=false});
</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

async function bookingAdminAction(req, env, url) {
  if (req.headers.get("x-requested-with") !== "admin") return json({ ok: false }, 403);
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== url.host) return json({ ok: false }, 403);
  let d; try { d = await req.json(); } catch { return json({ ok: false }, 400); }
  await init(env);
  if (d.action === "add") {
    if (!Object.hasOwn(SERVICES, d.service)) return json({ ok: false, error: "服務項目不正確" }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date || "") || !/^\d{2}:\d{2}$/.test(d.time || "")) return json({ ok: false, error: "請填寫日期與時間" }, 400);
    const minutes = Number(d.minutes), capacity = Number(d.capacity), weeks = Number(d.weeks) || 1;
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 240) return json({ ok: false, error: "課程長度請填 15–240 分鐘" }, 400);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 20) return json({ ok: false, error: "人數上限請填 1–20" }, 400);
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 12) return json({ ok: false, error: "重複週數不正確" }, 400);
    const [y, m, day] = d.date.split("-").map(Number);
    const now = new Date().toISOString();
    const stmts = [];
    const clash = [];
    for (let i = 0; i < weeks; i++) {
      const dt = new Date(Date.UTC(y, m - 1, day + i * 7)).toISOString().slice(0, 10);
      const startsAt = `${dt} ${d.time}`;
      if (startsAt <= twNow()) continue;
      const same = await env.DB.prepare("SELECT id FROM slots WHERE starts_at = ? AND status = 'open'").bind(startsAt).first();
      if (same) { clash.push(dt); continue; }
      stmts.push(env.DB.prepare("INSERT INTO slots (service, starts_at, minutes, capacity, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)")
        .bind(d.service, startsAt, minutes, capacity, now));
    }
    if (!stmts.length) return json({ ok: false, error: clash.length ? "這些時間已經有開放的時段了：" + clash.join("、") : "時間已經過了，請選之後的時間" }, 400);
    await env.DB.batch(stmts);
    return json({ ok: true, added: stmts.length, skipped: clash });
  }
  const id = Number(d.id);
  if (!Number.isInteger(id)) return json({ ok: false }, 400);
  if (d.action === "close") await env.DB.prepare("UPDATE slots SET status = 'closed' WHERE id = ?").bind(id).run();
  else if (d.action === "open") await env.DB.prepare("UPDATE slots SET status = 'open' WHERE id = ?").bind(id).run();
  else if (d.action === "delete") await env.DB.batch([
    env.DB.prepare("DELETE FROM bookings WHERE slot_id = ?").bind(id),
    env.DB.prepare("DELETE FROM slots WHERE id = ?").bind(id),
  ]);
  else if (d.action === "cancel-booking") await env.DB.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'booked'").bind(new Date().toISOString(), id).run();
  else return json({ ok: false }, 400);
  return json({ ok: true });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/api/feedback") {
        if (!env.DB) return json({ items: [], error: "not-configured" }, 503);
        if (req.method === "POST") return await submit(req, env);
        if (req.method === "GET") return await listApproved(env);
        return json({ ok: false }, 405);
      }
      if (p === "/api/booking/slots" || p === "/api/booking") {
        if (!env.DB) return json({ ok: false, error: "線上預約還沒有開放。" }, 503);
        if (req.method !== (p === "/api/booking" ? "POST" : "GET")) return json({ ok: false }, 405);
        const c = await checkCode(req, env);
        if (c instanceof Response) return c;
        return p === "/api/booking" ? await book(req, env, c.ipHash) : await listSlots(env);
      }
      if (p === "/api/booking/cancel") {
        if (!env.DB) return json({ ok: false, error: "線上預約還沒有開放。" }, 503);
        if (req.method === "GET") return await cancelInfo(env, url);
        if (req.method === "POST") return await cancelBooking(req, env);
        return json({ ok: false }, 405);
      }
      if (p === "/admin/booking" || p === "/admin/booking/" || p === "/admin/booking/action") {
        const a = authed(req, env);
        if (a !== true) return needAuth(a);
        if (!env.DB) return new Response("資料庫還沒有連上。", { status: 503 });
        if (p === "/admin/booking/action") return req.method === "POST" ? await bookingAdminAction(req, env, url) : json({ ok: false }, 405);
        return await bookingAdminPage(env, url);
      }
      if (p === "/admin" || p === "/admin/" || p === "/admin/action") {
        const a = authed(req, env);
        if (a !== true) return needAuth(a);
        if (!env.DB) return new Response("資料庫還沒有連上。", { status: 503 });
        if (p === "/admin/action") return req.method === "POST" ? await adminAction(req, env, url) : json({ ok: false }, 405);
        return await adminPage(env);
      }
    } catch (e) {
      return json({ ok: false, error: "server-error" }, 500);
    }
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response("Not found", { status: 404 });
  },
};
