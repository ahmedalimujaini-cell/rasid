// ملخص دوري على الإيميل كل N ساعة، عشان يوصلك تنبيه على الجوال من تطبيق الإيميل.
// فيه بس: الوظائف اللي قدّم عليها، ومسميات الوظائف اللي تحتاج تقدّم عليها بنفسك من مواقعها. بدون مشاكل ولا ردود ولا أي شي ثاني.
const nodemailer = require('nodemailer');
const store = require('./store');
const brief = require('./brief');

let busy = false;
const MAX_LINES = 25;

function due() {
  const d = store.load();
  const h = Number(d.config.digestEveryHours) || 0;
  return d.config.setupDone && h > 0 && !!d.config.gmail.appPassword && Date.now() - (d.state.lastDigest || 0) >= h * 3600000;
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const more = (n) => (n > 0 ? [`و${n} غيرها.`] : []);

// نص الرسالة من تاريخ معيّن. يرجّع { text, subject, nothing }.
function compose(d, since) {
  const name = brief.callName(d.config);
  const sent = d.jobs.filter((j) => j.status === 'sent' && j.sentAt > since).sort((a, b) => a.sentAt - b.sentAt);
  const titles = [...new Set(d.jobs.filter((j) => j.status === 'manual' && (j.foundAt || 0) > since).map((j) => clean(j.title)).filter(Boolean))];
  const lines = [];
  if (sent.length) {
    lines.push(`${name ? name + '، ' : ''}قدّمت لك على:`);
    for (const j of sent.slice(0, MAX_LINES)) lines.push(`- ${clean(j.title)}${clean(j.company) ? ' — ' + clean(j.company) : ''}`);
    lines.push(...more(sent.length - MAX_LINES));
  }
  if (titles.length) {
    if (lines.length) lines.push('');
    lines.push(`${!lines.length && name ? name + '، ' : ''}هذي المواقع تحتاج تقدّم عليها بنفسك:`);
    for (const t of titles.slice(0, MAX_LINES)) lines.push(`- ${t}`);
    lines.push(...more(titles.length - MAX_LINES));
  }
  const nothing = !sent.length && !titles.length;
  if (nothing) lines.push(`${name ? name + '، ' : ''}ما قدّمت على شي جديد من آخر رسالة.`);
  const subject = 'راصد: ' + (nothing ? 'ما في تقديم جديد' : [sent.length && `${sent.length} تقديم`, titles.length && `${titles.length} تقدّم عليها بنفسك`].filter(Boolean).join('، و'));
  return { text: lines.join('\n'), subject, nothing };
}

// يرسل الملخص لو في جديد. يرجّع true لو انرسل.
async function run(force) {
  if (busy) return false;
  busy = true;
  try {
    const d = store.load();
    const cfg = d.config;
    const since = d.state.lastDigest || 0;
    const { text, subject, nothing } = compose(d, since);
    d.state.lastDigest = Date.now();
    store.save();
    if (nothing && !force) return false; // ما في تقديم جديد: ما نزعجك برسالة
    const pass = String(cfg.gmail.appPassword || '').replace(/\s+/g, '');
    const transport = cfg.smtp
      ? nodemailer.createTransport({ ...cfg.smtp, auth: { user: cfg.gmail.user, pass } })
      : nodemailer.createTransport({ service: 'gmail', auth: { user: cfg.gmail.user, pass } });
    await transport.sendMail({
      from: { name: 'راصد', address: cfg.gmail.user },
      to: cfg.notifyEmail || cfg.gmail.user,
      subject,
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

module.exports = { due, run, compose };
