// Cloudflare Worker：學員回饋（先存「待審核」，Rou 確認後才公開）。其他網址交給靜態網站。
const SCHEMA = `CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  ip_hash TEXT
)`;
let ready = null;
async function init(env) {
  if (!ready) ready = env.DB.prepare(SCHEMA).run().catch((e) => { ready = null; throw e; });
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
<style>body{margin:0;background:#FAF4F1;color:#554F49;font:16px/1.8 "Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif}main{max-width:640px;margin:0 auto;padding:24px 16px 60px}h1{font-size:22px;margin:0 0 4px}.hint{color:#736861;font-size:14px;margin:0 0 20px}
article{background:#fff;border:1px solid #EBD7D9;border-radius:16px;padding:16px 18px;margin-bottom:14px}.s-pending{border-color:#A25D69}.top{display:flex;justify-content:space-between;font-size:13px;color:#736861}.tag{color:#A25D69}.msg{margin:8px 0 2px;white-space:pre-wrap;word-break:break-word}.who{margin:0;color:#736861;font-size:14px}
.btns{display:flex;gap:10px;margin-top:12px}button{font:inherit;font-size:14px;padding:6px 16px;border-radius:999px;border:1px solid #A25D69;background:#fff;color:#A25D69}button.go{background:#A25D69;color:#fff}button.del{border-color:#C9B8B0;color:#736861}</style></head>
<body><main><h1>學員回饋管理</h1><p class="hint">只有按「公開」的回饋會顯示在網站上。這個頁面不會被搜尋到。</p>${rows}</main>
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
