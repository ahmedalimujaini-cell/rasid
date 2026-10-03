// التحديث الذاتي: يشوف لو في نسخة أحدث في مصدر التحديث، وينزّل الملفات المتغيرة فقط ويعيد التشغيل.
// المصدر: مستودع GitHub عام (owner/repo). كل ملف يتحقق منه بـ sha256 قبل ما ينحط.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const store = require('./store');

const ROOT = path.join(__dirname, '..');
const DEFAULT_REPO = 'ahmedalimujaini-cell/rasid'; // مصدر التحديث الافتراضي
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const local = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));

function base() {
  if (process.env.RASID_UPDATE_BASE) return process.env.RASID_UPDATE_BASE;
  const repo = String(store.load().config.updateRepo || DEFAULT_REPO).trim();
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://raw.githubusercontent.com/${repo}/main` : '';
}

async function get(url) {
  const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url.split('/').pop()}`);
  return Buffer.from(await res.arrayBuffer());
}

const safePath = (p) => /^[\w\-./ ]+$/.test(p) && !p.includes('..') && !path.isAbsolute(p) && !/^(data|node_modules)\//.test(p);

// يرجّع { build, notes } لو في تحديث، أو null.
async function check() {
  const d = store.load();
  const b = base();
  if (!b) {
    d.state.update = null;
    return null;
  }
  const remote = JSON.parse((await get(b + '/version.json')).toString('utf8'));
  d.state.update = remote.build > local().build ? { build: remote.build, notes: String(remote.notes || '').slice(0, 400), found: Date.now() } : null;
  d.state.lastUpdateCheck = Date.now();
  store.save();
  return d.state.update;
}

async function install() {
  const b = base();
  if (!b) throw new Error('مصدر التحديث مو محدد.');
  const remote = JSON.parse((await get(b + '/version.json')).toString('utf8'));
  const mine = local();
  if (!(remote.build > mine.build)) return { updated: false, build: mine.build };

  const stage = path.join(store.DATA_DIR, 'update-stage');
  fs.rmSync(stage, { recursive: true, force: true });
  const changed = [];
  for (const [rel, want] of Object.entries(remote.files || {})) {
    if (!safePath(rel)) throw new Error('مسار غير مسموح في التحديث: ' + rel);
    const cur = path.join(ROOT, rel);
    if (fs.existsSync(cur) && sha(fs.readFileSync(cur)) === want) continue;
    const buf = await get(`${b}/${rel.split('/').map(encodeURIComponent).join('/')}`);
    if (sha(buf) !== want) throw new Error('ملف التحديث ما طابق التوقيع: ' + rel);
    const out = path.join(stage, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
    changed.push(rel);
  }
  // فحص صياغة كل ملفات JS الجديدة قبل ما نلمس النسخة الشغّالة
  for (const rel of changed.filter((f) => f.endsWith('.js'))) {
    const r = spawnSync(process.execPath, ['--check', path.join(stage, rel)], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('التحديث فيه خطأ في ' + rel + ' — ما ركّبته.');
  }
  const depsChanged = changed.includes('package.json');
  const backup = path.join(store.DATA_DIR, 'backup', String(mine.build));
  for (const rel of changed) {
    const cur = path.join(ROOT, rel);
    if (fs.existsSync(cur)) {
      fs.mkdirSync(path.dirname(path.join(backup, rel)), { recursive: true });
      fs.copyFileSync(cur, path.join(backup, rel));
    }
    fs.mkdirSync(path.dirname(cur), { recursive: true });
    fs.copyFileSync(path.join(stage, rel), cur);
  }
  fs.writeFileSync(path.join(ROOT, 'version.json'), JSON.stringify(remote, null, 2));
  fs.rmSync(stage, { recursive: true, force: true });
  if (depsChanged) {
    const r = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: ROOT, shell: process.platform === 'win32', encoding: 'utf8', timeout: 5 * 60 * 1000 });
    if (r.status !== 0) store.event('error', 'التحديث نزل، بس npm install فشل: ' + String(r.stderr || r.error || '').slice(0, 200));
  }
  const d = store.load();
  d.state.update = null;
  store.event('ok', `تحدّث البرنامج إلى النسخة ${remote.build}${remote.notes ? ': ' + String(remote.notes).slice(0, 200) : ''}`);
  store.saveNow();
  return { updated: true, build: remote.build, files: changed.length };
}

// يعيد تشغيل الخادم بالنسخة الجديدة.
function restart() {
  if (process.env.RASID_NO_RESTART) return;
  spawn(process.execPath, [path.join(ROOT, 'src', 'launch.js'), '--restart', '--background'], { cwd: ROOT, detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  setTimeout(() => process.exit(0), 400);
}

module.exports = { check, install, restart, local, base };
