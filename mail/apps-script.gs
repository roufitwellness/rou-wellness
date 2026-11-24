/**
 * Rou Wellness 預約通知信：用柔柔老師自己的 Gmail 寄信。
 *
 * 設定步驟（只要做一次）：
 * 1. 用你要寄信的 Gmail 帳號打開 https://script.google.com ，按「新專案」。
 * 2. 把這整個檔案的內容貼上，取代原本的程式碼，按儲存。
 * 3. 左邊「專案設定」（齒輪）→ 最下面「指令碼屬性」→ 新增：
 *      SECRET        一串只有你知道的長密碼（跟 Cloudflare 的 MAIL_SECRET 一樣）
 *      TEACHER_EMAIL 想收到「新預約通知」的信箱（不填就寄到這個 Gmail 自己）
 * 4. 上方選單選函式「authorize」→ 按「執行」→ 依指示允許寄信權限。
 * 5. 右上角「部署」→「新增部署作業」→ 類型選「網頁應用程式」：
 *      執行身分：我
 *      誰可以存取：所有人
 *    部署後複製「網頁應用程式網址」（https://script.google.com/macros/s/.../exec）。
 * 6. 在電腦終端機設定 Cloudflare：
 *      npx wrangler secret put MAIL_URL      ← 貼上第 5 步的網址
 *      npx wrangler secret put MAIL_SECRET   ← 貼上第 3 步的 SECRET
 *
 * 一般 Gmail 帳號每天最多寄給約 100 位收件者，小教室的預約量綽綽有餘。
 */
var SENDER_NAME = 'Rou Wellness 柔柔老師';

function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('SECRET');
  var d;
  try { d = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false }); }
  if (!secret || d.secret !== secret) return out({ ok: false });
  var teacher = props.getProperty('TEACHER_EMAIL') || Session.getEffectiveUser().getEmail();
  if (d.to && d.subject && d.body) {
    MailApp.sendEmail(d.to, d.subject, d.body, { name: SENDER_NAME, replyTo: teacher });
  }
  if (d.teacherSubject && teacher) {
    MailApp.sendEmail(teacher, d.teacherSubject, d.teacherBody || d.body || '', { name: 'Rou Wellness 預約系統', replyTo: d.to || teacher });
  }
  return out({ ok: true });
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// 第一次手動執行這個函式，讓 Google 詢問寄信權限。
function authorize() {
  Logger.log('今天還可以寄 ' + MailApp.getRemainingDailyQuota() + ' 封信');
}
