// ملخص دوري على الإيميل: «ايش الجديد» كل N ساعة، عشان يوصلك تنبيه على الجوال من تطبيق الإيميل.
const nodemailer = require('nodemailer');
const store = require('./store');
const brief = require('./brief');

let busy = false;

function due() {
  const d = store.load();
  const h = Number(d.config.digestEveryHours) || 0;
  return d.config.setupDone && h > 0 && !!d.config.gmail.appPassword && Date.now() - (d.state.lastDigest || 0) >= h * 3600000;
}

// يرسل الملخص لو في جديد. يرجّع true لو انرسل.
async function run(force) {
  if (busy) return false;
  busy = true;
  try {
    const d = store.load();
    const cfg = d.config;
    const since = d.state.lastDigest || 0;
    const { text, nothing, counts } = await brief.compose(since, true);
    d.state.lastDigest = Date.now();
    store.save();
    if (nothing && !force) return false; // ما في جديد: ما نزعجك برسالة فاضية
    const pass = String(cfg.gmail.appPassword || '').replace(/\s+/g, '');
    const transport = cfg.smtp
      ? nodemailer.createTransport({ ...cfg.smtp, auth: { user: cfg.gmail.user, pass } })
      : nodemailer.createTransport({ service: 'gmail', auth: { user: cfg.gmail.user, pass } });
    const head = nothing ? 'ما في جديد' : [counts.sent && `${counts.sent} تقديم`, counts.replies && `${counts.replies} رد`, counts.waiting && `${counts.waiting} تنتظرك`, counts.problems && `${counts.problems} مشكلة`].filter(Boolean).join('، ');
    await transport.sendMail({
      from: { name: 'راصد', address: cfg.gmail.user },
      to: cfg.notifyEmail || cfg.gmail.user,
      subject: `راصد: ${head}`,
      text: text + '\n\n— راصد، برنامج التقديم على الوظائف (رسالة تلقائية من جهازك)',
    });
    store.event('info', 'أرسلت لك ملخص الجديد على الإيميل.');
    return true;
  } catch (e) {
    store.event('error', 'ما قدرت أرسل الملخص على الإيميل: ' + String(e.message).slice(0, 160));
    return false;
  } finally {
    busy = false;
  }
}

module.exports = { due, run };
