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
// خيارات توفير (الموديل ومستوى التفكير): لو نسختك ما تعرف واحد منها، نتركه هو بس ونبقى على المستوى الخفيف
const OPTIONAL = ['--model', '--effort'];
const unsupported = new Set();
const SYSTEM = 'You are the engine of a personal job-application assistant. Follow the instructions in the user message exactly and reply only in the format it asks for. Use only the tools you are given.';

// model: 'haiku' (الأخف والأرخص) أو 'sonnet'. effort: low | medium | high (كل ما قل، قل التفكير وقل الاستهلاك).
function buildArgs({ tools, fast, model, effort, stream, mcpConfig, mcpTools }, lvl) {
  // stream: الرد يوصل كلمة كلمة (للمحادثة) بدل ما ننتظر لين يخلص
  const args = stream && lvl < 2 ? ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'] : ['-p', '--output-format', 'json'];
  const list = tools && tools.length ? tools.join(',') : '';
  // أدوات راصد نفسه (MCP) تنضاف للمسموح، وأدوات Claude Code المدمجة تبقى محصورة في القائمة
  const allowed = [...(tools || []), ...(mcpConfig ? ['mcp__rasid', ...(mcpTools || []).map((t) => 'mcp__rasid__' + t)] : [])].join(',');
  if (allowed) args.push('--allowedTools', allowed);
  if (mcpConfig) args.push('--mcp-config', mcpConfig);
  if (lvl <= 1) args.push('--permission-mode', 'dontAsk', '--strict-mcp-config');
  if (lvl === 0) {
    args.push('--disable-slash-commands', '--no-session-persistence', '--system-prompt', SYSTEM, '--tools', list);
    const m = model || (fast ? 'haiku' : '');
    if (m && !unsupported.has('--model')) args.push('--model', m);
    if (effort && !unsupported.has('--effort')) args.push('--effort', effort);
  }
  return args;
}

// زر «وقّف»: نقتل كل عمليات Claude الشغّالة، وأي طلب جديد يرفض لين تخلص الدورة
const active = new Map(); // العملية ← دالة ترفض الوعد فوراً (ما ننتظر إغلاق القنوات)
let stopFlag = false;
const stopRequested = () => stopFlag;
const clearStop = () => (stopFlag = false);
function stopAll() {
  stopFlag = true;
  for (const [c, abort] of active) {
    abort();
    try {
      if (process.platform === 'win32' && c.pid) spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      else c.kill();
    } catch (_) {}
  }
}

function spawnClaude(prompt, { tools, timeoutMs, cwd, fast, model, effort, onText, onTool, mcpConfig, mcpTools }, lvl) {
  if (stopFlag) return Promise.reject(new Error('CLAUDE_STOPPED: أوقفته أنت'));
  const cfg = store.load().config;
  const dir = cwd || SANDBOX;
  fs.mkdirSync(dir, { recursive: true });
  const streaming = !!onText && lvl < 2;
  const args = buildArgs({ tools, fast, model, effort, stream: streaming, mcpConfig, mcpTools }, lvl);

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
    active.set(child, () => {
      clearTimeout(timer);
      reject(new Error('CLAUDE_STOPPED: أوقفته أنت'));
    });
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
        } else if (ev.type === 'stream_event' && ev.event && ev.event.type === 'content_block_start' && ev.event.content_block && /tool_use/.test(ev.event.content_block.type || '')) {
          try {
            onTool && onTool(ev.event.content_block.name);
          } catch (_) {}
        } else if (ev.type === 'stream_event' && ev.event && ev.event.type === 'message_start') {
          acc = ''; // رسالة جديدة بعد استخدام أداة: نبدأ النص من جديد
        } else if (ev.type === 'result') final = ev;
      }
    });
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      active.delete(child);
      reject(new Error((e.code === 'ENOENT' ? 'CLAUDE_NOT_FOUND: ' : '') + e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      active.delete(child);
      if (stopFlag) return reject(new Error('CLAUDE_STOPPED: أوقفته أنت'));
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

const LIMIT_RE = /hit your .{0,24}limit|session limit|usage limit|weekly limit|rate.?limit|limit reached|\b429\b/i;

// من نص مثل "resets 12:10pm" نحسب متى يرجع الاستخدام (بتوقيت الجهاز). لو ما قدرنا نقراه: ساعة.
function limitUntil(message, now = Date.now()) {
  const m = String(message).match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return now + 60 * 60000;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  const t = new Date(now);
  t.setHours(h, Number(m[2] || 0), 0, 0);
  if (t.getTime() <= now) t.setDate(t.getDate() + 1);
  return t.getTime() + 2 * 60000; // دقيقتين احتياط
}

// اشتراك Claude واحد لكل الحسابات: وقت رجوع الاستخدام محفوظ في الحساب الرئيسي ويسري على الكل.
const shared = () => store.load(store.MAIN).state;

// كم باقي على رجوع الاستخدام (٠ = شغّال). لما يخلص الوقت تنمسح المشكلة لحالها.
function paused() {
  const st = shared();
  const until = st.aiPausedUntil || 0;
  if (!until) return 0;
  if (Date.now() >= until) {
    st.aiPausedUntil = 0;
    store.clearProblem('claude-limit', true);
    store.event('ok', 'رجع استخدام Claude. أكمّل الشغل.');
    return 0;
  }
  return until - Date.now();
}
// الوقت المكتوب تخمين: الحد ممكن ينفك قبله. لما تأمر أنت (بحث، محادثة، اختبار) نجرّب فعلياً؛ لو لسا الحد موجود يرجع يوقف لحاله.
function resume() {
  const st = shared();
  if (!st.aiPausedUntil) return;
  st.aiPausedUntil = 0;
  store.clearProblem('claude-limit', true);
  store.save();
}
const clock = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const pausedError = () => new Error('CLAUDE_LIMIT_PAUSED: وصلت حد استخدام Claude. يرجع الساعة ' + clock(shared().aiPausedUntil));

// خيار ما تعرفه نسخة Claude Code عندك: نشيله هو بس ونعيد (بدل ما ننزل مستوى ونخسر كل التوفير)
function dropOptional(msg) {
  const m = String(msg).match(/unknown option '(--[\w-]+)'/i);
  const flag = m && OPTIONAL.includes(m[1]) ? m[1] : /CLAUDE_(EXIT_|ERROR)/.test(msg) && /\beffort\b/i.test(msg) ? '--effort' : '';
  if (!flag || unsupported.has(flag)) return false;
  unsupported.add(flag);
  return true;
}

// يرجّع كائن JSON. tools: [] = بدون أدوات، أو ['WebSearch','WebFetch']. fast: استخدم الموديل السريع.
async function askJson(prompt, { tools = [], timeoutMs = 5 * 60 * 1000, mockKey, cwd, fast = false, model, effort, onText } = {}) {
  if (stopFlag) throw new Error('CLAUDE_STOPPED: أوقفته أنت');
  if (paused()) throw pausedError();
  if (process.env.RASID_MOCK) return require('../test/mock').reply(mockKey, prompt, { model: model || (fast ? 'haiku' : ''), effort });
  for (;;) {
    try {
      return extractJson(await spawnClaude(prompt, { tools, timeoutMs, cwd, fast, model, effort, onText }, level));
    } catch (e) {
      if (level === 0 && dropOptional(e.message)) continue;
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

// وكيل بأدوات: Claude يشتغل على الطلب، يستخدم أدوات راصد والويب قد ما يحتاج، ويرجّع الرد النهائي نص.
async function runAgent(prompt, { tools = [], mcpConfig, mcpTools = [], timeoutMs = 10 * 60 * 1000, model, effort, onText, onTool, mock } = {}) {
  if (stopFlag) throw new Error('CLAUDE_STOPPED: أوقفته أنت');
  if (paused()) throw pausedError();
  if (process.env.RASID_MOCK) return mock();
  for (;;) {
    try {
      return await spawnClaude(prompt, { tools, timeoutMs, model, effort, onText: onText || (() => {}), onTool, mcpConfig, mcpTools }, level);
    } catch (e) {
      if (level === 0 && dropOptional(e.message)) continue;
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
  if (m.includes('CLAUDE_STOPPED')) return; // أنت أوقفته: مو مشكلة
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
  } else if (m.includes('CLAUDE_LIMIT_PAUSED')) {
    // معروفة ومسجّلة: ما نكرر التنبيه
  } else if (LIMIT_RE.test(m)) {
    const st = shared();
    st.aiPausedUntil = limitUntil(m);
    store.problem(
      'claude-limit',
      `وصلت حد استخدام Claude في اشتراكك. يرجع الساعة ${clock(st.aiPausedUntil)}، وراصد يكمّل البحث من حيث وقف لحاله بعدها.`,
      'هذا حد الاشتراك مو خلل. لين يرجع: البحث والمحادثة وكتابة الرسائل موقفة، ومتابعة الردود وإرسال الجاهز شغّالة. عشان يكفيك أكثر: قلّل «هدف التقديمات في اليوم» من الإعدادات.',
      raw
    );
  } else {
    store.problem('claude-error', 'Claude Code رجّع خطأ — ' + what + ' ما اشتغل.', 'اضغط «جرّب Claude الحين». لو تكرر، انسخ نص الخطأ اللي تحت.', raw);
  }
}

// فحص سريع: هل Claude Code يرد؟ ينظّف مشاكل Claude لو اشتغل.
async function selfTest() {
  resume();
  try {
    const r = await askJson('Reply with ONLY this JSON object in a ```json block: {"ok":true}', { tools: [], timeoutMs: 120000, mockKey: 'selftest', fast: true });
    if (!r || r.ok !== true) throw new Error('رد غير متوقع من Claude');
  } catch (e) {
    reportAiError(e, 'الفحص');
    throw e;
  }
  clearClaudeProblems();
}

// Claude اشتغل: أي مشكلة قديمة عنه تنمسح في كل الحسابات
function clearClaudeProblems() {
  for (const k of ['claude-missing', 'claude-auth', 'claude-limit', 'claude-error']) store.clearProblem(k, true);
}

module.exports = { stopAll, stopRequested, clearStop, paused, resume, limitUntil, askJson, runAgent, extractJson, reportAiError, selfTest, clearClaudeProblems, buildArgs, getLevel: () => level, setLevel: (n) => (level = n), unsupported };
