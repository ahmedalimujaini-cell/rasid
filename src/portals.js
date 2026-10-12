// حساباتك في مواقع التوظيف (توطين، كوادر، تاليلنك): كلمة السر تنحفظ على جهازك فقط (مثل كلمة سر الجيميل)،
// ولا تنرسل لـClaude ولا تظهر في الواجهة. رمز التحقق (OTP) يُقرا من جيميلك بالقراءة فقط، ومن رسائل هالمواقع بس.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const store = require('./store');

const PORTALS = {
  tawteen: { name: 'منصة توطين', url: 'https://tawteen.om/', senders: ['tawteen.om', 'mol.gov.om', 'gov.om'] },
  kwader: { name: 'كوادر', url: 'https://kwader.mem.gov.om/', senders: ['mem.gov.om', 'gov.om'] },
  talilink: { name: 'تاليلنك', url: 'https://app.talilink.com/careers/account', senders: ['talilink.com'] },
};

// الأرقام العربية → إنجليزية
const latin = (s) => String(s || '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));

// يطلع رمز التحقق من نص الرسالة: رقم ٤-٨ خانات قريب من كلمة code/OTP/رمز، وإلا رقم من ٦ خانات لحاله.
function extractCode(text) {
  const t = latin(text);
  const near = t.match(/(?:code|otp|pin|passcode|verification|one[- ]time|رمز|كود|التحقق)[^0-9]{0,40}(\d{4,8})(?!\d)/i);
  if (near) return near[1];
  const lone = t.match(/(?<!\d)(\d{6})(?!\d)/);
  return lone ? lone[1] : '';
}

// أحدث رمز وصل بعد sinceMs من رسالة مرسلها من هالموقع. messages: [{ from, date, subject, text }]
function pickOtp(messages, key, sinceMs) {
  const p = PORTALS[key];
  if (!p) return '';
  const ok = (messages || [])
    .filter((m) => m && new Date(m.date).getTime() >= sinceMs - 60000)
    .filter((m) => {
      const from = String(m.from || '').toLowerCase();
      const domain = from.includes('@') ? from.split('@').pop().replace(/[>\s]/g, '') : from;
      return p.senders.some((s) => domain === s || domain.endsWith('.' + s));
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  for (const m of ok) {
    const code = extractCode(`${m.subject}\n${m.text}`);
    if (code) return code;
  }
  return '';
}

async function recentMail(sinceMs) {
  if (process.env.RASID_MOCK_MAIL) return require('../test/mailfix').otpMail || [];
  const cfg = store.load().config;
  if (!cfg.gmail.user || !cfg.gmail.appPassword) throw new Error('الجيميل مو مربوط بعد.');
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: cfg.gmail.user, pass: String(cfg.gmail.appPassword).replace(/\s+/g, '') }, logger: false });
  await client.connect();
  const out = [];
  try {
    await client.mailboxOpen('INBOX', { readOnly: true });
    const uids = ((await client.search({ since: new Date(sinceMs - 86400000) }, { uid: true })) || []).sort((a, b) => b - a).slice(0, 25);
    if (uids.length) {
      for await (const m of client.fetch(uids, { uid: true, source: true, internalDate: true }, { uid: true })) {
        const p = await simpleParser(m.source);
        out.push({ from: (p.from && p.from.value && p.from.value[0] && p.from.value[0].address) || '', date: p.date || m.internalDate, subject: p.subject || '', text: String(p.text || '').slice(0, 3000) });
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return out;
}

// ينتظر وصول رمز جديد (يفحص كل ٥ ثواني). يرجّع الرقم فقط، أو '' لو ما وصل.
async function waitOtp(key, sinceMs, { timeoutMs = 120000, everyMs = 5000 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const code = pickOtp(await recentMail(sinceMs), key, sinceMs);
    if (code) return code;
    if (Date.now() + everyMs > end) return '';
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// بيانات الدخول للاستخدام الداخلي فقط (ما تنرسل لـClaude ولا للواجهة)
function creds(key) {
  const c = store.load().config.portals && store.load().config.portals[key];
  return c && c.on && c.user && c.pass ? { user: c.user, pass: c.pass, name: PORTALS[key].name, url: PORTALS[key].url } : null;
}

module.exports = { PORTALS, extractCode, pickOtp, waitOtp, creds };
