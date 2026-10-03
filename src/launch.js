// المشغّل: يتأكد إن راصد شغّال في الخلفية (ويشغّله لو لا)، ثم يفتح نافذة البرنامج.
//   node src/launch.js               يشغّل ويفتح النافذة   (أيقونة سطح المكتب)
//   node src/launch.js --background  يشغّل بدون نافذة       (مع بدء ويندوز)
//   node src/launch.js --restart     ينتظر النسخة القديمة تطفي ثم يشغّل (بعد التحديث)
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const win = require('./window');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function state() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: win.PORT, path: '/api/state', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(body) : null);
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function startServer() {
  fs.mkdirSync(win.DATA, { recursive: true });
  const log = fs.openSync(path.join(win.DATA, 'rasid.log'), 'a');
  spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, RASID_NO_OPEN: '1' },
  }).unref();
}

(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--restart')) for (let i = 0; i < 40 && (await state()); i++) await sleep(500);
  let s = await state();
  if (!s) {
    startServer();
    for (let i = 0; i < 60 && !(s = await state()); i++) await sleep(500);
  }
  if (!s) {
    console.error('Rasid did not start. See data\\rasid.log');
    process.exit(1);
  }
  if (!args.includes('--background')) win.open(!!s.config.setupDone);
  process.exit(0);
})();
