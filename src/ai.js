// الذكاء: يشغّل Claude Code بدون واجهة (claude -p) ويرجّع JSON.
// - النص يُمرَّر عبر stdin (يتفادى مشاكل الاقتباس والعربي في PowerShell/cmd).
// - يشتغل داخل مجلد فاضي، وبصلاحيات محدودة: بحث وقراءة ويب فقط، ولا شي غيره.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const SANDBOX = path.join(store.DATA_DIR, 'ai-sandbox');

function extractJson(text) {
  if (!text) throw new Error('رد فاضي من Claude');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const first = text.search(/[{[]/);
  if (first >= 0) {
    const open = text[first];
    const close = open === '{' ? '}' : ']';
    const last = text.lastIndexOf(close);
    if (last > first) candidates.push(text.slice(first, last + 1));
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c.trim());
    } catch (_) {}
  }
  throw new Error('ما قدرت أقرأ JSON من رد Claude');
}

// مستويات التشغيل، من الأسرع للأضمن. لو نسخة Claude Code عندك ما تعرف خيار، ننزل مستوى ونثبت عليه.
//  0 خفيف: بدون تعليمات Claude Code الطويلة ولا أدواته ولا خوادم MCP (يقلّل المدخلات من ~35 ألف رمز إلى ~1.5 ألف)
//  1 مقيّد: الخيارات الأساسية فقط    2 أساسي: بدون أي خيار إضافي
let level = 0;
const SYSTEM = 'You are the engine of a personal job-application assistant. Follow the instructions in the user message exactly and reply only in the format it asks for. Use only the tools you are given.';

function buildArgs({ tools, fast, stream }, lvl) {
  // stream: الرد يوصل كلمة كلمة (للمحادثة) بدل ما ننتظر لين يخلص
  const args = stream && lvl < 2 ? ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'] : ['-p', '--output-format', 'json'];
  const list = tools && tools.length ? tools.join(',') : '';
  if (list) args.push('--allowedTools', list);
  if (lvl <= 1) args.push('--permission-mode', 'dontAsk', '--strict-mcp-config');
  if (lvl === 0) {
    args.push('--disable-slash-commands', '--no-session-persistence', '--system-prompt', SYSTEM, '--tools', list);
    if (fast) args.push('--model', 'haiku'); // المهام الخفيفة (المحادثة، تصنيف الردود) على الموديل السريع
  }
  return args;
}

function spawnClaude(prompt, { tools, timeoutMs, cwd, fast, onText }, lvl) {
  const cfg = store.load().config;
  const dir = cwd || SANDBOX;
  fs.mkdirSync(dir, { recursive: true });
  const streaming = !!onText && lvl < 2;
  const args = buildArgs({ tools, fast, stream: streaming }, lvl);

  return new Promise((resolve, reject) => {
    let child;
    try {
      const opts = { cwd: dir, windowsHide: true, env: process.env };
      const bin = cfg.claudePath || 'claude';
      if (process.platform === 'win32') {
        // على ويندوز claude غالباً ملف .cmd: لازم يمر عبر cmd، فنبني السطر كامل مع اقتباس القيم
        const q = (a) => (a === '' || /[\s,]/.test(a) ? `"${a}"` : a);
        child = spawn([q(bin), ...args.map(q)].join(' '), { ...opts, shell: true });
      } else {
        child = spawn(bin, args, opts);
      }
    } catch (e) {
      return reject(new Error('CLAUDE_NOT_FOUND: ' + e.message));
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('TIMEOUT: Claude تأخر أكثر من ' + Math.round(timeoutMs / 60000) + ' دقيقة'));
    }, timeoutMs);
    let acc = ''; // النص المتراكم أثناء البث
    let pending = '';
    let final = null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      if (!streaming) return;
      pending += d;
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch (_) {
          continue;
        }
        if (ev.type === 'stream_event' && ev.event && ev.event.delta && ev.event.delta.type === 'text_delta') {
          acc += ev.event.delta.text;
          try {
            onText(acc);
          } catch (_) {}
        } else if (ev.type === 'stream_event' && ev.event && ev.event.type === 'message_start') {
          acc = ''; // رسالة جديدة بعد استخدام أداة: نبدأ النص من جديد
        } else if (ev.type === 'result') final = ev;
      }
    });
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error((e.code === 'ENOENT' ? 'CLAUDE_NOT_FOUND: ' : '') + e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (/is not recognized|command not found|not found/i.test(err) && !out.trim()) {
        return reject(new Error('CLAUDE_NOT_FOUND: ' + err.trim().slice(0, 200)));
      }
      let parsed = final;
      if (!parsed && !streaming) {
        try {
          parsed = JSON.parse(out);
        } catch (_) {}
      }
      if (parsed && parsed.is_error) {
        return reject(new Error('CLAUDE_ERROR: ' + String(parsed.result || '').slice(0, 300)));
      }
      if (parsed && typeof parsed.result === 'string') return resolve(parsed.result);
      if (code !== 0) return reject(new Error('CLAUDE_EXIT_' + code + ': ' + (err || out).trim().slice(0, 300)));
      resolve(out);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(prompt, 'utf8'));
  });
}

// يرجّع كائن JSON. tools: [] = بدون أدوات، أو ['WebSearch','WebFetch']. fast: استخدم الموديل السريع.
async function askJson(prompt, { tools = [], timeoutMs = 5 * 60 * 1000, mockKey, cwd, fast = false, onText } = {}) {
  if (process.env.RASID_MOCK) return require('../test/mock').reply(mockKey, prompt);
  for (;;) {
    try {
      return extractJson(await spawnClaude(prompt, { tools, timeoutMs, cwd, fast, onText }, level));
    } catch (e) {
      // خيار غير معروف في نسختك (الخروج بخطأ قبل ما يبدأ): ننزل مستوى ونعيد. أخطاء الدخول والحدود والمهلة ما تنحل بالنزول.
      const flagProblem = /CLAUDE_EXIT_/.test(e.message) && !/authenticat|oauth|login|rate.?limit|usage limit/i.test(e.message);
      if (flagProblem && level < 2) {
        level++;
        continue;
      }
      throw e;
    }
  }
}

// يحوّل أخطاء التشغيل إلى مشكلة مفهومة تظهر في اللوحة.
function reportAiError(e, what) {
  const m = String(e.message || e);
  const raw = m.replace(/\s+/g, ' ').slice(0, 300); // نص الخطأ الأصلي يظهر في صفحة المشاكل
  if (m.includes('CLAUDE_NOT_FOUND')) {
    store.problem(
      'claude-missing',
      'ما لقيت Claude Code على الجهاز، وبدونه ما أقدر أبحث ولا أكتب رسائل التقديم.',
      'افتح PowerShell وشغّل: npm install -g @anthropic-ai/claude-code ثم شغّل claude مرة وحدة وسجّل دخولك.',
      raw
    );
  } else if (/not logged in|run \/login|invalid api key|authentication_error|failed to authenticate|oauth|unauthorized|\b401\b/i.test(m)) {
    store.problem('claude-auth', 'Claude Code مو مسجّل دخول.', 'افتح PowerShell وشغّل claude، اكتب /login وسجّل دخولك، بعدين اضغط «جرّب Claude الحين».', raw);
  } else if (/rate.?limit|usage limit|\b429\b/i.test(m)) {
    store.problem('claude-limit', 'وصلت حد الاستخدام في Claude — ' + what + ' توقف مؤقتاً.', 'بيرجع يحاول تلقائياً في الدورة الجاية.', raw);
  } else {
    store.problem('claude-error', 'Claude Code رجّع خطأ — ' + what + ' ما اشتغل.', 'اضغط «جرّب Claude الحين». لو تكرر، انسخ نص الخطأ اللي تحت.', raw);
  }
}

// فحص سريع: هل Claude Code يرد؟ ينظّف مشاكل Claude لو اشتغل.
async function selfTest() {
  try {
    const r = await askJson('Reply with ONLY this JSON object in a ```json block: {"ok":true}', { tools: [], timeoutMs: 120000, mockKey: 'selftest', fast: true });
    if (!r || r.ok !== true) throw new Error('رد غير متوقع من Claude');
  } catch (e) {
    reportAiError(e, 'الفحص');
    throw e;
  }
  for (const k of ['claude-missing', 'claude-auth', 'claude-limit', 'claude-error']) store.clearProblem(k);
}

module.exports = { askJson, extractJson, reportAiError, selfTest, buildArgs, getLevel: () => level, setLevel: (n) => (level = n) };
