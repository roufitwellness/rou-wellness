// Cloudflare Worker：學員回饋（先存「待審核」，Rou 確認後才公開）與學員預約（老師開時段，學員用 Google 或 Email 登入後選時段，並寄確認信）。其他網址交給靜態網站。
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
  user_id INTEGER,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'booked',
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  cancelled_at TEXT,
  ip_hash TEXT
)`,
  `CREATE INDEX IF NOT EXISTS bookings_slot ON bookings (slot_id, status)`,
  `CREATE INDEX IF NOT EXISTS bookings_user ON bookings (user_id, status)`,
  `CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_login TEXT
)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS login_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  ip_hash TEXT
)`,
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// 寄信：交給柔柔老師 Gmail 裡的 Google Apps Script 寄出（設定方法見 mail/apps-script.gs）。
// 沒設定 MAIL_URL 時就不寄，預約照常成功。用 waitUntil 在背景寄，學員不用等。
function sendMail(env, ctx, msg) {
  if (!env.MAIL_URL || !env.MAIL_SECRET) return;
  const job = fetch(env.MAIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: env.MAIL_SECRET, ...msg }),
  }).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(job);
}
const SIGN = "\n\n柔柔老師\nRou Wellness\n\n（這封信由預約系統自動寄出，有任何問題直接回覆這封信就可以了。）";

function mailBooked(origin, b) {
  const link = `${origin}/booking/?cancel=${encodeURIComponent(b.token)}`;
  return {
    to: b.email,
    subject: `預約完成：${b.service} ${b.when}`,
    body: `${b.name} 你好，\n\n你的課程已經預約好了：\n\n課程：${b.service}\n時間：${b.when}\n\n如果需要取消，請在開課前 ${CANCEL_BEFORE_HOURS} 小時以前用這個連結取消：\n${link}\n\n開課前 ${CANCEL_BEFORE_HOURS} 小時內要取消或改時間，請直接回覆這封信或傳訊息給我。\n\n期待見到你！${SIGN}`,
    teacherSubject: `新預約：${b.when} ${b.service}（${b.name}）`,
    teacherBody: `新預約\n\n課程：${b.service}\n時間：${b.when}\n姓名：${b.name}\nEmail：${b.email}\n電話／LINE：${b.contact || "（未填）"}\n備註：${b.note || "（無）"}\n\n管理頁：${origin}/admin/booking`,
  };
}
function mailCancelled(origin, b, byTeacher) {
  return {
    to: b.email,
    subject: `已取消預約：${b.service} ${b.when}`,
    body: byTeacher
      ? `${b.name} 你好，\n\n很抱歉，以下這堂課老師這邊需要取消：\n\n課程：${b.service}\n時間：${b.when}\n\n可以到 ${origin}/booking/ 看看其他時段，或直接回覆這封信跟我討論。${SIGN}`
      : `${b.name} 你好，\n\n已經幫你取消這堂課：\n\n課程：${b.service}\n時間：${b.when}\n\n謝謝你提早告知。之後想再預約，可以到 ${origin}/booking/ 選時段。${SIGN}`,
    ...(byTeacher ? {} : {
      teacherSubject: `學員取消：${b.when} ${b.service}（${b.name}）`,
      teacherBody: `學員自己取消了預約\n\n課程：${b.service}\n時間：${b.when}\n姓名：${b.name}\nEmail：${b.email}\n\n管理頁：${origin}/admin/booking`,
    }),
  };
}

// ---------------- 學員帳號（Google 登入／Email 登入連結）----------------
const SESSION_DAYS = 60;
const LINK_MINUTES = 15;
const COOKIE = "rou_s";
// 平常就是 Google 的正式網址；測試時可以用環境變數換成假的伺服器
const googleUrls = (env) => ({
  auth: env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth",
  token: env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token",
  userinfo: env.GOOGLE_USERINFO_URL || "https://openidconnect.googleapis.com/v1/userinfo",
});
const googleOn = (env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const mailOn = (env) => Boolean(env.MAIL_URL && env.MAIL_SECRET);

function getCookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : "";
}
function cookie(name, value, maxAge, secure) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
const isSecure = (url) => url.protocol === "https:";

async function currentUser(req, env) {
  const t = getCookie(req, COOKIE);
  if (!t || t.length > 60) return null;
  await init(env);
  return env.DB.prepare(
    "SELECT u.id, u.email, u.name, u.phone FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?"
  ).bind(await sha256("s:" + t), new Date().toISOString()).first();
}

async function startSession(env, email, name, url, redirect = "/booking/") {
  email = email.trim().toLowerCase();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (email, name, phone, created_at, last_login) VALUES (?, ?, '', ?, ?)
     ON CONFLICT(email) DO UPDATE SET last_login = excluded.last_login, name = CASE WHEN users.name = '' THEN excluded.name ELSE users.name END`
  ).bind(email, (name || "").trim().slice(0, 30), now, now).run();
  const u = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  const t = randomToken();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(await sha256("s:" + t), u.id, new Date(Date.now() + SESSION_DAYS * 86400 * 1000).toISOString()),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM login_links WHERE expires_at < ?").bind(now),
  ]);
  const h = new Headers({ location: redirect, "cache-control": "no-store" });
  h.append("set-cookie", cookie(COOKIE, t, SESSION_DAYS * 86400, isSecure(url)));
  h.append("set-cookie", cookie("rou_g", "", 0, isSecure(url)));
  return new Response(null, { status: 303, headers: h });
}

const loginFail = (reason) => new Response(null, { status: 303, headers: { location: "/booking/?login=" + reason, "cache-control": "no-store" } });

// Google 登入：先導到 Google，回來時用 state cookie 確認是同一個人發起的
function googleStart(env, url) {
  if (!googleOn(env)) return loginFail("off");
  const state = randomToken();
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: url.origin + "/auth/google/callback",
    response_type: "code", scope: "openid email profile", state, prompt: "select_account",
  });
  return new Response(null, { status: 302, headers: {
    location: googleUrls(env).auth + "?" + q, "cache-control": "no-store",
    "set-cookie": cookie("rou_g", state, 600, isSecure(url)),
  } });
}

async function googleCallback(req, env, url) {
  if (!googleOn(env)) return loginFail("off");
  const state = url.searchParams.get("state") || "";
  const saved = getCookie(req, "rou_g");
  const code = url.searchParams.get("code");
  if (!code || !saved || !safeEqual(state, saved)) return loginFail("fail");
  const g = googleUrls(env);
  const tr = await fetch(g.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({
    code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: url.origin + "/auth/google/callback", grant_type: "authorization_code",
  }) });
  if (!tr.ok) return loginFail("fail");
  const tok = await tr.json();
  const ur = await fetch(g.userinfo, { headers: { authorization: "Bearer " + tok.access_token } });
  if (!ur.ok) return loginFail("fail");
  const info = await ur.json();
  if (!info.email || info.email_verified === false || info.email_verified === "false") return loginFail("fail");
  await init(env);
  return startSession(env, info.email, info.name || "", url);
}

async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true; // 還沒設定就先不檢查
  if (!token) return false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
    });
    const d = await r.json();
    return Boolean(d.success);
  } catch { return false; }
}

// Email 登入連結：寄一封有登入連結的信，15 分鐘內有效、只能用一次
async function emailLinkRequest(req, env, ctx, url) {
  if (!mailOn(env)) return json({ ok: false, error: "Email 登入還沒有開放，請用 Google 登入。" }, 503);
  let d; try { d = await req.json(); } catch { return json({ ok: false, error: "格式不正確" }, 400); }
  const email = String(d.email || "").trim().toLowerCase().slice(0, 100);
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: "請填寫正確的 Email" }, 400);
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  if (!(await verifyTurnstile(env, d.turnstile, ip))) return json({ ok: false, error: "驗證沒有通過，請重新整理頁面再試一次。", retry: true }, 403);
  await init(env);
  const ipHash = await sha256("rou:" + ip);
  const hour = new Date(Date.now() - 3600 * 1000).toISOString();
  const a = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_links WHERE ip_hash = ? AND created_at > ?").bind(ipHash, hour).first();
  const b = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_links WHERE email = ? AND created_at > ?").bind(email, hour).first();
  if ((a && a.n >= 6) || (b && b.n >= 3)) return json({ ok: false, error: "寄送太頻繁，請稍後再試，或先看看信箱裡有沒有之前的登入信。" }, 429);
  const t = randomToken();
  await env.DB.prepare("INSERT INTO login_links (token_hash, email, created_at, expires_at, ip_hash) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256("l:" + t), email, new Date().toISOString(), new Date(Date.now() + LINK_MINUTES * 60 * 1000).toISOString(), ipHash).run();
  sendMail(env, ctx, {
    to: email, subject: "Rou Wellness 預約登入連結",
    body: `你好，\n\n點下面的連結就能登入預約系統（${LINK_MINUTES} 分鐘內有效，只能使用一次）：\n\n${url.origin}/auth/email?t=${encodeURIComponent(t)}\n\n如果不是你本人要求的，不用理會這封信。${SIGN}`,
  });
  return json({ ok: true });
}

// 點信裡的連結會先看到一個「登入」按鈕，按下去才真的登入（避免信箱的安全掃描先把連結用掉）
function emailLinkPage(url) {
  const t = url.searchParams.get("t") || "";
  const html = `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>登入預約系統｜Rou Wellness</title>
<style>body{margin:0;background:#FAF4F1;color:#554F49;font:16px/1.8 "Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;display:grid;place-items:center;min-height:100vh}main{max-width:360px;padding:24px 16px;text-align:center}h1{font-size:22px;font-weight:500}button{font:inherit;padding:11px 32px;border-radius:999px;border:0;background:#A25D69;color:#fff;cursor:pointer}</style></head>
<body><main><h1>登入 Rou Wellness 預約系統</h1><form method="post" action="/auth/email"><input type="hidden" name="t" value="${esc(t)}"><button type="submit">登入</button></form></main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", "referrer-policy": "no-referrer" } });
}

async function emailLinkLogin(req, env, url) {
  let t = "";
  try { t = String((await req.formData()).get("t") || ""); } catch {}
  if (!t || t.length > 60) return loginFail("expired");
  await init(env);
  const h = await sha256("l:" + t);
  const r = await env.DB.prepare("UPDATE login_links SET used = 1 WHERE token_hash = ? AND used = 0 AND expires_at > ? RETURNING email")
    .bind(h, new Date().toISOString()).first();
  if (!r) return loginFail("expired");
  return startSession(env, r.email, "", url);
}

async function logout(req, env, url) {
  const t = getCookie(req, COOKIE);
  if (t) { await init(env); await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256("s:" + t)).run(); }
  return json({ ok: true }, 200, { "set-cookie": cookie(COOKIE, "", 0, isSecure(url)) });
}

async function me(req, env) {
  const u = await currentUser(req, env);
  return json({
    user: u ? { name: u.name, email: u.email, phone: u.phone } : null,
    google: googleOn(env), emailLogin: mailOn(env), turnstileSiteKey: env.TURNSTILE_SECRET ? env.TURNSTILE_SITE_KEY || "" : "",
  }, 200, { "cache-control": "no-store" });
}

async function myBookings(env, user) {
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.status, s.service, s.starts_at, s.minutes FROM bookings b JOIN slots s ON s.id = b.slot_id
     WHERE b.user_id = ? AND b.status = 'booked' AND s.starts_at > ? ORDER BY s.starts_at LIMIT 50`
  ).bind(user.id, twNow()).all();
  const cut = twNow(CANCEL_BEFORE_HOURS);
  return json({ ok: true, items: (results || []).map((b) => ({
    id: b.id, service: b.service, when: zhWhen(b.starts_at, b.minutes), canCancel: b.starts_at > cut,
  })) }, 200, { "cache-control": "no-store" });
}

async function myCancel(req, env, ctx, url, user) {
  let d; try { d = await req.json(); } catch { return json({ ok: false }, 400); }
  const b = await env.DB.prepare(
    "SELECT b.id, b.name, b.email, b.status, s.service, s.starts_at, s.minutes FROM bookings b JOIN slots s ON s.id = b.slot_id WHERE b.id = ? AND b.user_id = ?"
  ).bind(Number(d.id), user.id).first();
  if (!b) return json({ ok: false, error: "找不到這筆預約。" }, 404);
  return doCancel(env, ctx, url, b);
}

// 登入後的 API 只接受從本站送出的請求
function sameSite(req, url) {
  if (req.headers.get("x-requested-with") !== "rou") return false;
  const o = req.headers.get("origin");
  return !o || new URL(o).host === url.host;
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

async function book(req, env, ctx, url, user) {
  let d; try { d = await req.json(); } catch { return json({ ok: false, error: "格式不正確" }, 400); }
  const slotId = Number(d.slot_id);
  const name = String(d.name || "").trim().slice(0, 30);
  const contact = String(d.contact || "").trim().slice(0, 60);
  const note = String(d.note || "").trim().slice(0, 300);
  const email = user.email;
  if (!Number.isInteger(slotId)) return json({ ok: false, error: "請先選擇時段" }, 400);
  if (!name) return json({ ok: false, error: "請填寫姓名" }, 400);
  const since = new Date(Date.now() - 86400 * 1000).toISOString();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND created_at > ?").bind(user.id, since).first();
  if (recent && recent.n >= 10) return json({ ok: false, error: "今天預約太多次了，請直接傳訊息給老師" }, 429);
  const dup = await env.DB.prepare("SELECT id FROM bookings WHERE slot_id = ? AND status = 'booked' AND user_id = ?").bind(slotId, user.id).first();
  if (dup) return json({ ok: false, error: "你已經預約過這個時段了" }, 409);
  const token = randomToken();
  // 一個指令內同時檢查「時段開放、還沒截止、還有名額」，避免兩個人同時搶到最後一個位子
  const r = await env.DB.prepare(
    `INSERT INTO bookings (slot_id, user_id, name, email, contact, note, status, token, created_at)
     SELECT s.id, ?, ?, ?, ?, ?, 'booked', ?, ? FROM slots s
     WHERE s.id = ? AND s.status = 'open' AND s.starts_at > ?
       AND (SELECT COUNT(*) FROM bookings b WHERE b.slot_id = s.id AND b.status = 'booked') < s.capacity`
  ).bind(user.id, name, email, contact, note, token, new Date().toISOString(), slotId, twNow(BOOK_BEFORE_HOURS)).run();
  if (!r.meta || r.meta.changes !== 1) return json({ ok: false, error: "這個時段剛好額滿或已關閉，請選其他時段。", full: true }, 409);
  await env.DB.prepare("UPDATE users SET name = ?, phone = ? WHERE id = ?").bind(name, contact, user.id).run();
  const s = await env.DB.prepare("SELECT service, starts_at, minutes FROM slots WHERE id = ?").bind(slotId).first();
  const when = zhWhen(s.starts_at, s.minutes);
  sendMail(env, ctx, mailBooked(url.origin, { token, service: s.service, when, name, email, contact, note }));
  return json({ ok: true, service: s.service, when, email, mail: mailOn(env) });
}

async function bookingByToken(env, token) {
  if (!token || token.length < 20 || token.length > 40) return null;
  await init(env);
  return env.DB.prepare(
    `SELECT b.id, b.name, b.email, b.status, s.service, s.starts_at, s.minutes FROM bookings b JOIN slots s ON s.id = b.slot_id WHERE b.token = ?`
  ).bind(token).first();
}

async function cancelInfo(env, url) {
  const b = await bookingByToken(env, url.searchParams.get("t") || "");
  if (!b) return json({ ok: false, error: "找不到這筆預約，連結可能不完整。" }, 404);
  const canCancel = b.status === "booked" && b.starts_at > twNow(CANCEL_BEFORE_HOURS);
  return json({ ok: true, name: b.name, service: b.service, when: zhWhen(b.starts_at, b.minutes), status: b.status, canCancel, cancelBeforeHours: CANCEL_BEFORE_HOURS }, 200, { "cache-control": "no-store" });
}

async function cancelBooking(req, env, ctx, url) {
  let d; try { d = await req.json(); } catch { return json({ ok: false, error: "格式不正確" }, 400); }
  const b = await bookingByToken(env, String(d.token || ""));
  if (!b) return json({ ok: false, error: "找不到這筆預約。" }, 404);
  return doCancel(env, ctx, url, b);
}

async function doCancel(env, ctx, url, b) {
  if (b.status !== "booked") return json({ ok: true });
  if (b.starts_at <= twNow(CANCEL_BEFORE_HOURS)) return json({ ok: false, error: `開課前 ${CANCEL_BEFORE_HOURS} 小時內無法線上取消，請直接傳訊息給老師。` }, 409);
  const r = await env.DB.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'booked'").bind(new Date().toISOString(), b.id).run();
  if (r.meta && r.meta.changes === 1) sendMail(env, ctx, mailCancelled(url.origin, { ...b, when: zhWhen(b.starts_at, b.minutes) }, false));
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
      `SELECT id, slot_id, name, email, contact, note, status, created_at FROM bookings WHERE slot_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`
    ).bind(...ids).all();
    for (const b of bs || []) (bySlot[b.slot_id] ||= []).push(b);
  }
  let lastDate = "";
  const cards = (slots || []).map((s) => {
    const bs = bySlot[s.id] || [];
    const active = bs.filter((b) => b.status === "booked");
    const head = s.starts_at.slice(0, 10) !== lastDate ? `<h2 class="day">${esc(zhWhen(s.starts_at, s.minutes).split("）")[0])}）</h2>` : "";
    lastDate = s.starts_at.slice(0, 10);
    const people = bs.map((b) => `<li class="b-${b.status}"><div><b>${esc(b.name)}</b>　<a href="mailto:${esc(b.email)}">${esc(b.email)}</a>${b.contact ? "　" + esc(b.contact) : ""}${b.status === "cancelled" ? '　<span class="x">已取消</span>' : ""}
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
  const warns = [];
  if (!mailOn(env)) warns.push("還沒有設定寄信（MAIL_URL、MAIL_SECRET）：學員收不到確認信，也不能用 Email 登入。");
  if (!googleOn(env)) warns.push("還沒有設定 Google 登入（GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET）。");
  if (!mailOn(env) && !googleOn(env)) warns.push("目前沒有任何登入方式，學員無法預約。");
  if (!env.TURNSTILE_SECRET || !env.TURNSTILE_SITE_KEY) warns.push("還沒有設定 Turnstile 機器人驗證（TURNSTILE_SITE_KEY、TURNSTILE_SECRET）。");
  const mailHint = warns.map((w) => `<p class="warn">⚠️ ${esc(w)}</p>`).join("");
  const html = `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>預約管理</title>
<style>body{margin:0;background:#FAF4F1;color:#554F49;font:16px/1.8 "Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif}main{max-width:680px;margin:0 auto;padding:24px 16px 60px}${NAV_CSS}h1{font-size:22px;margin:0 0 4px}.hint{color:#736861;font-size:14px;margin:0 0 20px}.warn{background:#FCEBDD;border-radius:12px;padding:8px 14px;font-size:14px;margin:0 0 8px}
form.add{background:#fff;border:1px solid #EBD7D9;border-radius:16px;padding:16px 18px;margin:0 0 24px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}form.add h2{grid-column:1/-1;font-size:17px;margin:0}form.add label{display:grid;gap:4px;font-size:14px;color:#736861}form.add .full{grid-column:1/-1}
input,select{font:inherit;color:#554F49;background:#fff;border:1px solid #EBD7D9;border-radius:10px;padding:7px 10px;min-width:0}
.tabs{display:flex;gap:14px;font-size:14px;margin:0 0 8px}.tabs a{color:#736861}.tabs a.on{color:#A25D69;font-weight:500}
h2.day{font-size:16px;margin:26px 0 8px;color:#A25D69}
article{background:#fff;border:1px solid #EBD7D9;border-radius:16px;padding:14px 18px;margin-bottom:12px}.s-closed{opacity:.65}.top{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.tag{font-size:13px;color:#2F6F5E}.tag.full{color:#A25D69}.tag.closed{color:#736861}.cnt{margin:2px 0;font-size:14px;color:#736861}
ul{list-style:none;margin:8px 0 0;padding:0}li{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:8px 0;border-top:1px dashed #EBD7D9;word-break:break-word}li.b-cancelled{color:#A99D96}li a{color:#A25D69}.x{font-size:13px}.note{font-size:14px;color:#736861;white-space:pre-wrap}
.btns{display:flex;gap:10px;margin-top:10px}button{font:inherit;font-size:14px;padding:5px 14px;border-radius:999px;border:1px solid #A25D69;background:#fff;color:#A25D69;cursor:pointer;white-space:nowrap}button.go{background:#A25D69;color:#fff}button.del{border-color:#C9B8B0;color:#736861}
@media (max-width:520px){form.add{grid-template-columns:1fr}}</style></head>
<body><main>${ADMIN_NAV("bk")}<h1>學員預約管理</h1><p class="hint">在這裡開放時段，學員登入後就能在 <a href="/booking/">/booking/</a> 頁面選時段（這個網址沒有放在網站選單上，請自己傳給學員），預約和取消都會寄信通知學員和你。開課前 ${BOOK_BEFORE_HOURS} 小時停止線上預約，${CANCEL_BEFORE_HOURS} 小時內學員不能自行取消。</p>${mailHint}
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
if(a==="delete"&&!confirm(Number(b.dataset.n)>0?"這個時段還有學員預約，刪除後會寄取消通知給這些學員，預約紀錄也會一起刪掉。確定嗎？":"確定要刪除這個時段嗎？"))return;
if(a==="cancel-booking"&&!confirm("確定要取消這位學員的預約嗎？系統會寄信通知學員。"))return;
b.disabled=true;await send({action:a,id:Number(b.dataset.id)});b.disabled=false});
</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

async function bookingAdminAction(req, env, ctx, url) {
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
  else if (d.action === "delete") {
    const { results: bs } = await env.DB.prepare(
      "SELECT b.name, b.email, s.service, s.starts_at, s.minutes FROM bookings b JOIN slots s ON s.id = b.slot_id WHERE b.slot_id = ? AND b.status = 'booked'"
    ).bind(id).all();
    await env.DB.batch([
    env.DB.prepare("DELETE FROM bookings WHERE slot_id = ?").bind(id),
      env.DB.prepare("DELETE FROM slots WHERE id = ?").bind(id),
    ]);
    for (const b of bs || []) if (b.starts_at > twNow()) sendMail(env, ctx, mailCancelled(url.origin, { ...b, when: zhWhen(b.starts_at, b.minutes) }, true));
  }
  else if (d.action === "cancel-booking") {
    const b = await env.DB.prepare(
      "SELECT b.name, b.email, s.service, s.starts_at, s.minutes FROM bookings b JOIN slots s ON s.id = b.slot_id WHERE b.id = ? AND b.status = 'booked'"
    ).bind(id).first();
    const r = await env.DB.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'booked'").bind(new Date().toISOString(), id).run();
    if (b && r.meta && r.meta.changes === 1 && b.starts_at > twNow()) sendMail(env, ctx, mailCancelled(url.origin, { ...b, when: zhWhen(b.starts_at, b.minutes) }, true));
  }
  else return json({ ok: false }, 400);
  return json({ ok: true });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/api/feedback") {
        if (!env.DB) return json({ items: [], error: "not-configured" }, 503);
        if (req.method === "POST") return await submit(req, env);
        if (req.method === "GET") return await listApproved(env);
        return json({ ok: false }, 405);
      }
      if (p.startsWith("/auth/") || p === "/api/me" || p === "/api/logout" || p === "/api/login-link" || p.startsWith("/api/my/") || p === "/api/booking/slots" || p === "/api/booking") {
        if (!env.DB) return json({ ok: false, error: "線上預約還沒有開放。" }, 503);
        if (p === "/auth/google") return googleStart(env, url);
        if (p === "/auth/google/callback") return await googleCallback(req, env, url);
        if (p === "/auth/email") return req.method === "POST" ? await emailLinkLogin(req, env, url) : emailLinkPage(url);
        if (p === "/api/me") return await me(req, env);
        if (p === "/api/booking/slots") { await init(env); return await listSlots(env); }
        if (req.method !== "GET" && !sameSite(req, url)) return json({ ok: false }, 403);
        if (p === "/api/login-link") return req.method === "POST" ? await emailLinkRequest(req, env, ctx, url) : json({ ok: false }, 405);
        if (p === "/api/logout") return req.method === "POST" ? await logout(req, env, url) : json({ ok: false }, 405);
        const user = await currentUser(req, env);
        if (!user) return json({ ok: false, error: "請先登入。", login: true }, 401);
        if (p === "/api/booking") return req.method === "POST" ? await book(req, env, ctx, url, user) : json({ ok: false }, 405);
        if (p === "/api/my/bookings") return await myBookings(env, user);
        if (p === "/api/my/cancel") return req.method === "POST" ? await myCancel(req, env, ctx, url, user) : json({ ok: false }, 405);
        return json({ ok: false }, 404);
      }
      if (p === "/api/booking/cancel") {
        if (!env.DB) return json({ ok: false, error: "線上預約還沒有開放。" }, 503);
        if (req.method === "GET") return await cancelInfo(env, url);
        if (req.method === "POST") return await cancelBooking(req, env, ctx, url);
        return json({ ok: false }, 405);
      }
      if (p === "/admin/booking" || p === "/admin/booking/" || p === "/admin/booking/action") {
        const a = authed(req, env);
        if (a !== true) return needAuth(a);
        if (!env.DB) return new Response("資料庫還沒有連上。", { status: 503 });
        if (p === "/admin/booking/action") return req.method === "POST" ? await bookingAdminAction(req, env, ctx, url) : json({ ok: false }, 405);
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
