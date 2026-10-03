// يفتح راصد كنافذة برنامج مستقلة (بدون شريط عنوان ولا تبويبات) بدل تبويب في المتصفح.
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');

const PORT = Number(process.env.RASID_PORT) || 4747;
const DATA = process.env.RASID_DATA || path.join(__dirname, '..', 'data');

function findBrowser() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = [];
  // Edge أول: فيه الأصوات العربية الطبيعية للموجز الصوتي
  for (const r of roots) candidates.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  for (const r of roots) candidates.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  return candidates.find((p) => fs.existsSync(p)) || '';
}

// asApp=false أثناء الإعداد الأول: يفتح في متصفحك العادي عشان تكون مسجّل في جوجل.
function open(asApp) {
  const link = `http://127.0.0.1:${PORT}`;
  if (process.platform === 'win32' && asApp) {
    const exe = findBrowser();
    if (exe) {
      spawn(
        exe,
        [
          `--app=${link}`,
          `--user-data-dir=${path.join(DATA, 'app-window')}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--autoplay-policy=no-user-gesture-required',
          '--window-size=1320,880',
        ],
        { detached: true, stdio: 'ignore' }
      ).unref();
      return 'app';
    }
  }
  const cmd = process.platform === 'win32' ? `start "" "${link}"` : process.platform === 'darwin' ? `open "${link}"` : `xdg-open "${link}"`;
  exec(cmd, () => {});
  return 'browser';
}

module.exports = { open, findBrowser, PORT, DATA };
