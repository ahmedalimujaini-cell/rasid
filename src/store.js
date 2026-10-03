// تخزين محلي بسيط: ملف JSON واحد داخل مجلد data على جهازك فقط.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.RASID_DATA || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'rasid.json');

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
    mode: 'auto', // auto = يرسل تلقائياً | review = تراجع قبل الإرسال
    voice: true, // الموجز الصوتي عند فتح البرنامج
    digestEveryHours: 6, // ملخص على الإيميل كل كم ساعة (0 = لا)
    notifyEmail: '', // وين يروح الملخص (فاضي = نفس الجيميل)
    minFit: 70,
    dailyCap: 8,
    searchEveryHours: 12,
    inboxEveryMinutes: 10,
    newsEveryHours: 24,
    followUpDays: 10,
    letterLanguage: 'auto', // auto | en | ar
    letterNotes: '', // ملاحظة دائمة لكل الرسائل (تنضاف من المحادثة)
    claudePath: 'claude',
    updateRepo: '', // مصدر التحديث: owner/repo على GitHub
    autoUpdate: true, // يركّب التحديث لحاله أول ما ينزل
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

let db = null;
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

function load() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let raw = {};
  if (fs.existsSync(DB_FILE)) {
    try {
      raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      // ملف تالف: نحتفظ بنسخة منه ونبدأ من جديد بدل ما نخسر كل شي بصمت
      fs.copyFileSync(DB_FILE, DB_FILE + '.corrupt-' + Date.now());
      raw = {};
    }
  }
  db = deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), raw);
  // طلب صاحب البرنامج: الملخص كل ٦ ساعات (ترقية لمرة وحدة؛ بعدها يغيّره من الإعدادات براحته)
  if (!db.state.digest6) {
    if (db.config.digestEveryHours === 12) db.config.digestEveryHours = 6;
    db.state.digest6 = true;
  }
  // ترقية من النسخة الأولى: جولاتها كانت ثابتة على شركات النفط. اللي ما انرسل منها يتجاهل.
  for (const j of db.jobs) {
    if ((j.pass === 'operators' || j.pass === 'services') && !j.sentAt && j.status !== 'skipped') {
      j.status = 'skipped';
      j.lastError = 'من بحث النسخة القديمة (شركات النفط) — تجاهلتها تلقائياً.';
    }
  }
  return db;
}

function saveNow() {
  if (!db) return;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
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

function clearProblem(key) {
  const d = load();
  let changed = false;
  for (const p of d.problems) {
    if (p.key === key && !p.resolved) {
      p.resolved = true;
      changed = true;
    }
  }
  if (changed) save();
}

module.exports = { load, save, saveNow, id, event, problem, clearProblem, DATA_DIR, rev: () => rev };
