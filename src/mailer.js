// الإرسال من جيميلك عبر SMTP بكلمة مرور التطبيقات (App Password).
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const store = require('./store');

function transport(cfg) {
  const pass = String(cfg.gmail.appPassword || '').replace(/\s+/g, '');
  if (cfg.smtp) return nodemailer.createTransport({ ...cfg.smtp, auth: { user: cfg.gmail.user, pass } });
  return nodemailer.createTransport({ service: 'gmail', auth: { user: cfg.gmail.user, pass } });
}

function explain(e) {
  const m = String((e && e.message) || e);
  if (/Username and Password not accepted|Invalid login|535|AUTHENTICATIONFAILED|Invalid credentials/i.test(m))
    return 'جيميل رفض الدخول. لازم «كلمة مرور التطبيقات» (١٦ حرف) مو كلمة السر العادية.';
  if (/Application-specific password required|534/i.test(m)) return 'جيميل يطلب كلمة مرور التطبيقات — كلمة السر العادية ما تشتغل هنا.';
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ECONNRESET/i.test(m)) return 'ما في اتصال بالإنترنت أو جيميل ما يرد.';
  if (/Daily user sending|quota|550 5\.4\.5/i.test(m)) return 'جيميل وقّف الإرسال مؤقتاً (تجاوزت حد الإرسال اليومي).';
  return m.slice(0, 200);
}

async function verify() {
  const cfg = store.load().config;
  if (!cfg.gmail.user || !cfg.gmail.appPassword) throw new Error('حط الجيميل وكلمة مرور التطبيقات أول.');
  try {
    await transport(cfg).verify();
  } catch (e) {
    throw new Error(explain(e));
  }
}

function cvPath(cfg) {
  return cfg.cv.file ? path.join(store.DATA_DIR, cfg.cv.file) : '';
}

function sentToday(d) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return d.jobs.filter((j) => j.sentAt >= start.getTime()).length;
}

// يرسل رسالة التقديم (أو المتابعة) لوظيفة واحدة.
async function sendJob(job, kind = 'application') {
  const d = store.load();
  const cfg = d.config;
  const draft = kind === 'followup' ? job.followUp : job.draft;
  if (!draft) throw new Error('ما في رسالة جاهزة لهالوظيفة.');
  if (!job.applyEmail) throw new Error('ما في إيميل للتقديم على هالوظيفة.');
  if (kind === 'application' && job.sentAt) throw new Error('قدّمت على هالوظيفة من قبل.');
  const cv = cvPath(cfg);
  if (kind === 'application' && (!cv || !fs.existsSync(cv))) {
    store.problem('cv-missing', 'ما في سيرة ذاتية مرفوعة، وما أرسل تقديم بدونها.', 'ارفع ملف السيرة من الإعدادات.');
    throw new Error('السيرة الذاتية مو مرفوعة.');
  }
  const mail = {
    from: { name: cfg.profile.name, address: cfg.gmail.user },
    to: job.applyEmail,
    subject: draft.subject,
    text: draft.body,
  };
  if (kind === 'application') mail.attachments = [{ filename: cfg.cv.originalName || 'CV.pdf', path: cv }];
  if (kind === 'followup' && job.messageId) {
    mail.inReplyTo = job.messageId;
    mail.references = job.messageId;
  }
  try {
    const info = await transport(cfg).sendMail(mail);
    if (kind === 'application') {
      job.status = 'sent';
      job.sentAt = Date.now();
      job.messageId = info.messageId || '';
      store.event('ok', `أرسلت التقديم على «${job.title}» في ${job.company} إلى ${job.applyEmail}`, job.id);
    } else {
      job.followUpSentAt = Date.now();
      store.event('ok', `أرسلت متابعة لـ ${job.company} بخصوص «${job.title}»`, job.id);
    }
    job.lastError = '';
    store.clearProblem('gmail-auth');
    store.clearProblem('gmail-send');
    store.save();
    return info;
  } catch (e) {
    const why = explain(e);
    job.lastError = why;
    store.save();
    if (/كلمة مرور التطبيقات|رفض الدخول/.test(why)) {
      store.problem('gmail-auth', why, 'من الإعدادات: جدّد كلمة مرور التطبيقات من myaccount.google.com/apppasswords');
    } else if (/الإنترنت|حد الإرسال/.test(why)) {
      store.problem('gmail-send', why, 'بيرجع يحاول في الدورة الجاية.');
    } else {
      // مشكلة في هالوظيفة بالذات (مثلاً عنوان مرفوض)
      job.status = 'failed';
      store.event('error', `ما انرسل التقديم على «${job.title}» في ${job.company}: ${why}`, job.id);
      store.save();
    }
    throw new Error(why);
  }
}

module.exports = { verify, sendJob, sentToday, cvPath, explain };
