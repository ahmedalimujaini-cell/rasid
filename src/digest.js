// ملخص دوري على الإيميل كل N ساعة، عشان يوصلك تنبيه على الجوال من تطبيق الإيميل.
// فيه بس: الوظائف اللي قدّم عليها، والوظائف اللي تحتاج تقدّم عليها بنفسك من مواقعها (مع الرابط والمطلوب). بدون مشاكل ولا ردود ولا أي شي ثاني.
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

const link = (u) => (/^https?:\/\/\S+$/i.test(clean(u)) ? clean(u) : '');

// نص الرسالة من تاريخ معيّن. يرجّع { text, subject, nothing }.
// allManual = كل الوظائف اللي تنتظر تقدّم عليها بنفسك، مو بس الجديدة (لما يطلبها من المحادثة)
function compose(d, since, { allManual = false } = {}) {
  const name = brief.callName(d.config);
  const sent = d.jobs.filter((j) => j.status === 'sent' && j.sentAt > since).sort((a, b) => a.sentAt - b.sentAt);
  const seen = new Set();
  const manual = d.jobs.filter((j) => j.status === 'manual' && (allManual || (j.foundAt || 0) > since) && clean(j.title)).filter((j) => {
    const k = (clean(j.title) + '|' + link(j.url)).toLowerCase();
    return seen.has(k) ? false : seen.add(k);
  });
  const titles = manual;
  const lines = [];
  if (sent.length) {
    lines.push(`${name ? name + '، ' : ''}قدّمت لك على:`);
    for (const j of sent.slice(0, MAX_LINES)) lines.push(`- ${clean(j.title)}${clean(j.company) ? ' — ' + clean(j.company) : ''}`);
    lines.push(...more(sent.length - MAX_LINES));
  }
  if (titles.length) {
    if (lines.length) lines.push('');
    lines.push(`${!lines.length && name ? name + '، ' : ''}هذي المواقع تحتاج تقدّم عليها بنفسك:`);
    for (const j of titles.slice(0, MAX_LINES)) {
      lines.push(`- ${clean(j.title)}${clean(j.company) ? ' — ' + clean(j.company) : ''}`);
      if (link(j.url)) lines.push(`  الرابط: ${link(j.url)}`);
      const steps = String(j.applySteps || '').split(/\n+/).map(clean).filter(Boolean).join('، ');
      if (steps) lines.push(`  المطلوب: ${steps.slice(0, 600)}`);
    }
    lines.push(...more(titles.length - MAX_LINES));
  }
  const nothing = !sent.length && !titles.length;
  if (nothing) lines.push(`${name ? name + '، ' : ''}ما قدّمت على شي جديد من آخر رسالة.`);
  const subject = 'راصد: ' + (nothing ? 'ما في تقديم جديد' : [sent.length && `${sent.length} تقديم`, titles.length && `${titles.length} تقدّم عليها بنفسك`].filter(Boolean).join('، و'));
  return { text: lines.join('\n'), subject, nothing };
}

// يرسل الملخص لو في جديد. يرجّع true لو انرسل.
// opts.allManual = كل الوظائف اللي تنتظر تقدّم عليها بنفسك (طلبها من المحادثة)
async function run(force, opts = {}) {
  if (busy) return false;
  busy = true;
  try {
    const d = store.load();
    const cfg = d.config;
    const since = d.state.lastDigest || 0;
    const { text, subject, nothing } = compose(d, since, opts);
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
