// Rou Wellness 預約寄信：讓預約系統用這個 Gmail 寄確認信和通知。
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
