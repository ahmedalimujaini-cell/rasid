// يجهّز نسخة للنشر: يرفع رقم البناء ويحسب sha256 لكل ملف.   node scripts/release.js "ملاحظات التحديث"
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const SHIP = ['package.json', 'README.md', 'start.ps1', 'autostart.ps1', 'rasid.ico', 'src', 'public', 'scripts', 'test'];
const files = {};
const walk = (rel) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return;
  if (fs.statSync(abs).isDirectory()) return fs.readdirSync(abs).sort().forEach((f) => walk(rel + '/' + f));
  files[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
};
SHIP.forEach(walk);
const vf = path.join(ROOT, 'version.json');
const prev = fs.existsSync(vf) ? JSON.parse(fs.readFileSync(vf, 'utf8')) : { build: 0 };
const same = JSON.stringify(prev.files) === JSON.stringify(files);
const out = { build: same ? prev.build : prev.build + 1, date: new Date().toISOString().slice(0, 10), notes: process.argv[2] || prev.notes || '', files };
fs.writeFileSync(vf, JSON.stringify(out, null, 2));
console.log(`build ${out.build} — ${Object.keys(files).length} files${same ? ' (no changes)' : ''}`);
