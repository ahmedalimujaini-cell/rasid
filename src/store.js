// تخزين محلي بسيط: ملف JSON لكل حساب داخل مجلد data على جهازك فقط.
// الحساب الرئيسي في data/ نفسه (زي قبل)، وكل حساب إضافي في data/accounts/<id>/ منفصل تماماً (جيميل، سيرة، وظائف، ردود).
// كل طلب أو مهمة تشتغل «داخل» حساب واحد (AsyncLocalStorage)، فباقي البرنامج يستخدم load() بدون ما يعرف كم حساب في.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const DATA_DIR = process.env.RASID_DATA || path.join(__dirname, '..', 'data');
const MAIN = 'main';
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const ACCOUNT_ID = /^[a-f0-9]{12}$/;
const MAX_EXTRA = 5;

const DEFAULTS = {
  config: {
    setupDone: false,
    gmail: { user: '', appPassword: '' },
    profile: {
      name: '',
      nickname: '',
      phone: '',
      location: '',
      linkedin: '',
      headline: '',
      summary: '',
      targets: '',
      avoid: '',
      nationality: '',
      birthDate: '',
      noticePeriod: '',
      extra: '',
    },
    cv: { file: '', originalName: '', text: '' },
    mode: 'auto', // auto = يرسل تلقائياً بدون ما يرجع لك | review = تراجع قبل الإرسال
    voice: true, // الموجز الصوتي عند فتح البرنامج
    digestEveryHours: 6, // ملخص على الإيميل كل كم ساعة (0 = لا)
    notifyEmail: '', // وين يروح الملخص (فاضي = نفس الجيميل)
    minFit: 70,
    dailyCap: 20, // هدف اليوم: يبحث لين يجهّز هالعدد من التقديمات بالإيميل، ويرسلها، وخلاص
    searchHour: 10, // البحث اليومي: مرة وحدة في اليوم الساعة ١٠ الصبح
    inboxEveryMinutes: 10,
    followUpDays: 10,
    letterLanguage: 'auto', // auto | en | ar
    letterNotes: '', // ملاحظة دائمة لكل الرسائل (تنضاف من المحادثة)
    claudePath: 'claude',
    updateRepo: '', // مصدر التحديث: owner/repo على GitHub
    autoAI: true, // true = يبحث لحاله كل يوم الساعة searchHour. false = ما يستخدم Claude إلا بأمرك
    smtp: null, // للاختبار فقط
  },
  jobs: [],
  messages: [],
  events: [],
  problems: [],
  news: [],
  brief: null, // { text, at, heard }
  chat: [],
  state: { lastSearch: 0, lastInbox: 0, lastNews: 0, lastUid: 0, uidValidity: 0, lastBriefHeard: 0, briefDirty: false, dirIndex: 0, lastDigest: 0 },
};

const als = new AsyncLocalStorage();
const current = () => als.getStore() || MAIN;
const dbs = new Map(); // الحساب ← بياناته في الذاكرة
const gone = new Set(); // حسابات انحذفت وهي مفتوحة: ما ننحفظ لها شي
let reg = null;
let saveTimer = null;
let rev = 0; // يزيد مع كل تغيير: الواجهة ما تعيد الرسم إلا لو تغيّر

function deepMerge(base, extra) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const k of Object.keys(extra || {})) {
    out[k] = k in base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])
      ? deepMerge(base[k], extra[k])
      : extra[k];
  }
  return out;
}

// ---- الحسابات ----
function registry() {
  if (reg) return reg;
  try {
    const r = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    reg = (Array.isArray(r.list) ? r.list : []).filter((a) => a && ACCOUNT_ID.test(a.id));
  } catch (_) {
    reg = [];
  }
  return reg;
}
function writeRegistry(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = ACCOUNTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ list }, null, 2));
  fs.renameSync(tmp, ACCOUNTS_FILE);
  reg = list;
}
const exists = (id) => id === MAIN || registry().some((a) => a.id === id);
const dirOf = (id) => (id === MAIN ? DATA_DIR : path.join(DATA_DIR, 'accounts', id));
const dir = () => dirOf(current());
const ids = () => [MAIN, ...registry().map((a) => a.id)];

// يشغّل fn داخل حساب معيّن: كل load() و save() جوّاها (وكل اللي يتفرع منها) تخص هالحساب.
function within(id, fn) {
  if (!exists(id)) throw new Error('هالحساب مو موجود.');
  return als.run(id, fn);
}

function accounts() {
  return ids().map((id) => {
    const d = load(id);
    const p = d.config.profile;
    const label = id === MAIN ? '' : (registry().find((a) => a.id === id) || {}).label || '';
    const first = String(p.name || '').trim().split(/\s+/)[0];
    return { id, name: label || p.nickname || first || (id === MAIN ? 'حسابي' : 'حساب جديد'), email: d.config.gmail.user, ready: !!d.config.setupDone };
  });
}

function addAccount(label) {
  const list = registry().slice();
  if (list.length >= MAX_EXTRA) throw new Error(`وصلت الحد: ${MAX_EXTRA} حسابات إضافية.`);
  const id = crypto.randomBytes(6).toString('hex');
  list.push({ id, label: String(label || '').replace(/\s+/g, ' ').trim().slice(0, 40), created: Date.now() });
  fs.mkdirSync(dirOf(id), { recursive: true });
  writeRegistry(list);
  return id;
}

// ما نمسح شي: مجلد الحساب ينتقل لـ data/removed عشان يرجع لو احتجته.
function removeAccount(id) {
  if (id === MAIN) throw new Error('الحساب الرئيسي ما ينحذف.');
  if (!exists(id)) throw new Error('هالحساب مو موجود.');
  saveNow();
  writeRegistry(registry().filter((a) => a.id !== id));
  gone.add(id);
  const src = dirOf(id);
  if (fs.existsSync(src)) {
    const dest = path.join(DATA_DIR, 'removed', id + '-' + Date.now());
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
  }
  rev++;
}

// ---- البيانات ----
function migrate(db) {
  // طلب صاحب البرنامج: الملخص كل ٦ ساعات (ترقية لمرة وحدة؛ بعدها يغيّره من الإعدادات براحته)
  if (!db.state.digest6) {
    if (db.config.digestEveryHours === 12) db.config.digestEveryHours = 6;
    db.state.digest6 = true;
  }
  // طلبه بعدين: بحث مرة وحدة كل يوم الساعة ١٠، يوصل ٢٠ تقديم ويرسلها لحاله بدون ما يرجع له
  if (!db.state.daily20) {
    db.config.mode = 'auto';
    db.config.autoAI = true;
    if (!(db.config.dailyCap >= 20)) db.config.dailyCap = 20;
    db.state.daily20 = true;
  }
  // ترقية من النسخة الأولى: جولاتها كانت ثابتة على شركات النفط. اللي ما انرسل منها يتجاهل.
  for (const j of db.jobs) {
    if ((j.pass === 'operators' || j.pass === 'services') && !j.sentAt && j.status !== 'skipped') {
      j.status = 'skipped';
      j.lastError = 'من بحث النسخة القديمة (شركات النفط) — تجاهلتها تلقائياً.';
    }
    // البرنامج انقطع وهو يرسل هالتقديم: ما نعرف وصل أو لا، فما نعيد الإرسال لحالنا (ما نقدّم مرتين أبداً)
    if (j.sendingAt && !j.sentAt) {
      j.status = 'failed';
      j.lastError = 'انقطع البرنامج وهو يرسل هالتقديم. شيّك في «المرسل» بجيميلك قبل ما تعيد الإرسال.';
    }
    delete j.sendingAt;
  }
}

function load(id = current()) {
  if (dbs.has(id)) return dbs.get(id);
  let raw = {};
  if (id !== MAIN && !exists(id)) {
    gone.add(id); // حساب انحذف: نسخة في الذاكرة فقط، ما تنكتب على القرص
  } else {
    const folder = dirOf(id);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'rasid.json');
    if (fs.existsSync(file)) {
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        // ملف تالف: نحتفظ بنسخة منه ونبدأ من جديد بدل ما نخسر كل شي بصمت
        fs.copyFileSync(file, file + '.corrupt-' + Date.now());
        raw = {};
      }
    }
  }
  const db = deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), raw);
  migrate(db);
  dbs.set(id, db);
  return db;
}

function saveNow() {
  clearTimeout(saveTimer);
  for (const [id, db] of dbs) {
    if (gone.has(id)) continue;
    const file = path.join(dirOf(id), 'rasid.json');
    const tmp = file + '.tmp';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, file);
  }
}

function save() {
  rev++;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
}

const id = () => crypto.randomBytes(6).toString('hex');

function event(level, text, jobId) {
  const d = load();
  d.events.unshift({ id: id(), t: Date.now(), level, text, jobId: jobId || null });
  if (d.events.length > 600) d.events.length = 600;
  save();
}

// مشكلة تحتاج انتباهك. key يمنع تكرار نفس المشكلة.
function problem(key, text, fix, detail) {
  const d = load();
  const existing = d.problems.find((p) => p.key === key && !p.resolved);
  if (existing) {
    existing.t = Date.now();
    existing.text = text;
    existing.fix = fix || existing.fix;
    existing.detail = detail || '';
  } else {
    d.problems.unshift({ id: id(), key, t: Date.now(), text, fix: fix || '', detail: detail || '', resolved: false });
    event('error', text);
  }
  save();
}

// everywhere = في كل الحسابات (مثل مشاكل Claude: الاشتراك واحد للكل)
function clearProblem(key, everywhere = false) {
  let changed = false;
  for (const acct of everywhere ? ids() : [current()]) {
    for (const p of load(acct).problems) {
      if (p.key === key && !p.resolved) {
        p.resolved = true;
        changed = true;
      }
    }
  }
  if (changed) save();
}

module.exports = {
  load, save, saveNow, id, event, problem, clearProblem,
  DATA_DIR, MAIN, current, within, dir, dirOf, exists, ids, accounts, addAccount, removeAccount,
  rev: () => rev,
};
