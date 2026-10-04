// راصد — الخادم المحلي. يشتغل على جهازك فقط (127.0.0.1) وما ينفتح على الشبكة.
const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const pipeline = require('./pipeline');
const mailer = require('./mailer');
const draft = require('./draft');
const ai = require('./ai');
const brief = require('./brief');
const chat = require('./chat');
const win = require('./window');
const update = require('./update');

const PORT = Number(process.env.RASID_PORT) || 4747;
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('الملف أكبر من المسموح.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const signature = () => `${store.rev()}|${pipeline.status.main}|${pipeline.status.acct}|${pipeline.inboxBusy.has(store.current())}|${pipeline.status.frozen}|${store.current()}|${process.pid}`;

// اللي يشتغل الحين: لو لحساب ثاني، نذكر اسمه
function busyLabel() {
  const st = pipeline.status;
  if (!st.main) return '';
  if (!st.acct || st.acct === store.current()) return st.main;
  const other = store.accounts().find((a) => a.id === st.acct);
  return `${other ? other.name : 'حساب ثاني'}: ${st.main}`;
}

// يوقف كل شي قبل التحديث، ويرجّعه لو التركيب فشل
const updateHooks = { before: () => pipeline.freeze(), after: () => pipeline.unfreeze() };

function publicState() {
  const d = store.load();
  const main = store.load(store.MAIN);
  const run = d.state.run && d.state.run.date === pipeline.dayKey() ? d.state.run : null;
  const cfg = JSON.parse(JSON.stringify(d.config));
  cfg.gmail.hasPassword = !!cfg.gmail.appPassword;
  delete cfg.gmail.appPassword;
  cfg.cv.hasText = !!cfg.cv.text;
  delete cfg.cv.text;
  delete cfg.smtp;
  return {
    config: cfg,
    jobs: d.jobs,
    messages: d.messages,
    events: d.events.slice(0, 200),
    problems: d.problems.filter((p) => !p.resolved),
    news: d.news,
    brief: d.brief,
    chat: d.chat.slice(-40),
    version: update.local().build,
    update: main.state.update || null,
    updateError: main.state.updateError || '',
    updating: pipeline.status.frozen,
    state: d.state,
    status: { main: busyLabel(), mine: !pipeline.status.acct || pipeline.status.acct === store.current(), inbox: pipeline.inboxBusy.has(store.current()), since: pipeline.status.since },
    sentToday: mailer.sentToday(d),
    today: { run, nextSearch: pipeline.nextSearch(d), paused: ai.paused() },
    account: store.current(),
    accounts: store.accounts(),
    sig: signature(),
    now: Date.now(),
  };
}

// ما يحتاجه منفّذ أوامر المحادثة من باقي البرنامج
function chatDeps() {
  return {
    applyConfig,
    briefDirty: brief.dirty,
    busy: () => pipeline.status.main,
    run: {
      search: () => pipeline.cycle(true).catch((e) => store.event('error', String(e.message).slice(0, 200))),
      news: () => pipeline.news().catch((e) => store.event('error', String(e.message).slice(0, 200))),
      inbox: () => pipeline.checkInbox(),
    },
    // يكتب رسالة الوظيفة المضافة الحين (وفي الوضع التلقائي يرسلها)؛ لو مشغول تنكتب في الدورة الجاية
    draftNow: () => {
      if (pipeline.status.main) return;
      pipeline
        .withMain('يكتب رسالة التقديم', async () => {
          await draft.draftPending((l) => (pipeline.status.main = l));
          if (await pipeline.autoSend()) brief.dirty();
        })
        .catch((e) => store.event('error', String(e.message).slice(0, 200)));
    },
  };
}

const num = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : dflt);

function applyConfig(body) {
  const c = store.load().config;
  if (body.gmail) {
    if (typeof body.gmail.user === 'string') c.gmail.user = body.gmail.user.trim();
    if (body.gmail.appPassword) c.gmail.appPassword = String(body.gmail.appPassword).trim();
  }
  if (body.profile) for (const k of Object.keys(c.profile)) if (typeof body.profile[k] === 'string') c.profile[k] = body.profile[k].trim().slice(0, 3000);
  if (body.mode === 'review' || body.mode === 'auto') c.mode = body.mode;
  if (['auto', 'en', 'ar'].includes(body.letterLanguage)) c.letterLanguage = body.letterLanguage;
  if (typeof body.voice === 'boolean') c.voice = body.voice;
  if (typeof body.autoAI === 'boolean') c.autoAI = body.autoAI;
  if ('digestEveryHours' in body) c.digestEveryHours = [0, 6, 12, 24].includes(Number(body.digestEveryHours)) ? Number(body.digestEveryHours) : c.digestEveryHours;
  if (typeof body.notifyEmail === 'string' && (body.notifyEmail.trim() === '' || /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(body.notifyEmail.trim()))) c.notifyEmail = body.notifyEmail.trim();
  if (typeof body.updateRepo === 'string') c.updateRepo = body.updateRepo.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$|\/$/g, '').slice(0, 120);
  if ('minFit' in body) c.minFit = num(body.minFit, 0, 100, c.minFit);
  if ('dailyCap' in body) c.dailyCap = num(body.dailyCap, 1, 30, c.dailyCap);
  if ('searchHour' in body) c.searchHour = num(body.searchHour, 0, 23, c.searchHour);
  if ('inboxEveryMinutes' in body) c.inboxEveryMinutes = num(body.inboxEveryMinutes, 2, 240, c.inboxEveryMinutes);
  if ('followUpDays' in body) c.followUpDays = num(body.followUpDays, 3, 60, c.followUpDays);
  if (body.setupDone === true) {
    if (!c.setupDone) store.event('ok', 'خلص الإعداد. راصد بدأ الشغل.');
    c.setupDone = true;
  }
  store.save();
}

async function api(req, res, url) {
  const d = store.load();
  const route = req.method + ' ' + url.pathname;

  if (route === 'GET /api/state') {
    // الواجهة تسأل كل ٥ ثواني: لو ما تغيّر شي نرد برد صغير بدل كل البيانات
    if (url.searchParams.get('sig') === signature()) return json(res, 200, { same: true });
    return json(res, 200, publicState());
  }
  if (route === 'GET /api/chat/live') {
    const lv = chat.live();
    return json(res, 200, { text: lv.text, tool: lv.tool, busy: lv.busy });
  }

  // حماية: أي تعديل لازم يجي من صفحة راصد نفسها (ترويسة خاصة + نفس العنوان)
  const host = String(req.headers.host || '');
  if (req.headers['x-rasid'] !== '1' || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return json(res, 403, { error: 'مرفوض.' });

  if (route === 'POST /api/cv') {
    const name = decodeURIComponent(String(req.headers['x-filename'] || 'cv.pdf')).replace(/[\\/:*?"<>|]/g, '_');
    const ext = path.extname(name).toLowerCase();
    if (!['.pdf', '.doc', '.docx'].includes(ext)) return json(res, 400, { error: 'ارفع السيرة بصيغة PDF أو Word.' });
    const buf = await readBody(req, 10 * 1024 * 1024);
    if (buf.length < 500) return json(res, 400, { error: 'الملف فاضي.' });
    const file = 'cv' + ext;
    fs.mkdirSync(store.dir(), { recursive: true });
    fs.writeFileSync(path.join(store.dir(), file), buf);
    d.config.cv = { file, originalName: name, text: '' };
    store.clearProblem('cv-missing');
    store.save();
    return json(res, 200, { ok: true, name });
  }

  const raw = await readBody(req, 512 * 1024);
  const body = raw.length ? JSON.parse(raw.toString('utf8')) : {};

  if (route === 'POST /api/config') {
    const was = d.config.mode;
    applyConfig(body);
    // تحويل للإرسال التلقائي: الجاهز ينرسل الحين بدل ما ينتظر الدورة الجاية
    if (was !== 'auto' && d.config.mode === 'auto' && d.config.setupDone && !pipeline.status.main) {
      pipeline.withMain('يرسل التقديمات الجاهزة', async () => ((await pipeline.autoSend()) ? brief.dirty() : null)).catch((e) => store.event('error', String(e.message).slice(0, 200)));
    }
    return json(res, 200, publicState());
  }
  if (route === 'POST /api/gmail/test') {
    applyConfig({ gmail: body.gmail || {} });
    await mailer.verify();
    store.clearProblem('gmail-auth');
    return json(res, 200, { ok: true });
  }
  if (route === 'POST /api/digest/test') {
    const sent = await require('./digest').run(true);
    return sent ? json(res, 200, publicState()) : json(res, 400, { error: 'ما انرسل — شوف آخر سطر في الموجز.' });
  }
  // التحديث إجباري: لو لقى نسخة أحدث، يوقف كل شي ويركّبها ويعيد التشغيل على طول
  if (route === 'POST /api/update/check' || route === 'POST /api/update/install') {
    if (!update.base()) return json(res, 400, { error: 'مصدر التحديث مو محدد بعد.' });
    const out = await update.auto(updateHooks);
    return json(res, 200, { ...publicState(), installing: !!out.updated, updated: !!out.updated, build: out.build });
  }
  if (route === 'POST /api/accounts/add') {
    const id = store.addAccount(body.label);
    store.within(id, () => store.event('ok', 'انفتح الحساب. كمّل الإعداد: الجيميل، السيرة، والمعلومات.'));
    return json(res, 200, { id });
  }
  if (route === 'POST /api/accounts/remove') {
    const acct = store.current();
    if (acct === store.MAIN) return json(res, 400, { error: 'الحساب الرئيسي ما ينحذف.' });
    if (pipeline.status.acct === acct || pipeline.inboxBusy.has(acct) || chat.live().busy) return json(res, 409, { error: 'هالحساب يشتغل الحين. وقّفه أول أو جرّب بعد شوي.' });
    store.removeAccount(acct);
    return json(res, 200, { ok: true });
  }
  if (route === 'POST /api/claude/test') {
    try {
      await ai.selfTest();
      store.event('ok', 'Claude Code يشتغل تمام.');
      return json(res, 200, publicState());
    } catch (e) {
      return json(res, 400, { error: 'Claude ما رد: ' + String(e.message).replace(/\s+/g, ' ').slice(0, 220) });
    }
  }
  // أدوات المحادثة: يناديها خادم MCP اللي يشغّله Claude أثناء «كلّم راصد»
  const tm = url.pathname.match(/^\/api\/tool\/(\w+)$/);
  if (tm && req.method === 'POST') return json(res, 200, await chat.callTool(tm[1], body));
  if (route === 'POST /api/chat') {
    if (pipeline.status.frozen) return json(res, 409, { error: 'راصد يتحدّث الحين — ثواني وكلّمني.' });
    ai.resume();
    const out = await chat.handle(body.text, chatDeps(), { spoken: !!body.spoken });
    return json(res, 200, { ...out, state: publicState() });
  }
  if (route === 'POST /api/brief/open') return json(res, 200, { brief: await brief.onOpen() });
  if (route === 'POST /api/brief/refresh') {
    ai.resume();
    return json(res, 200, { brief: await brief.generate(true) });
  }
  if (route === 'POST /api/brief/heard') {
    brief.heard();
    return json(res, 200, publicState());
  }
  if (route === 'POST /api/cv/read') return json(res, 200, { profile: await pipeline.readCv() });

  if (route === 'POST /api/run/search') {
    if (pipeline.status.frozen) return json(res, 409, { error: 'راصد يتحدّث الحين — ثواني ويرجع.' });
    if (pipeline.status.main) return json(res, 409, { error: 'مشغول الحين: ' + busyLabel() });
    ai.resume();
    pipeline.cycle(true).catch((e) => store.event('error', String(e.message).slice(0, 200)));
    return json(res, 200, { ok: true });
  }
  if (route === 'POST /api/run/stop') return json(res, 200, { ok: true, stopped: pipeline.stop() });
  if (route === 'POST /api/run/news') {
    if (pipeline.status.frozen) return json(res, 409, { error: 'راصد يتحدّث الحين — ثواني ويرجع.' });
    if (pipeline.status.main) return json(res, 409, { error: 'مشغول الحين: ' + busyLabel() });
    ai.resume();
    pipeline.news().catch((e) => store.event('error', String(e.message).slice(0, 200)));
    return json(res, 200, { ok: true });
  }
  if (route === 'POST /api/run/inbox') {
    const n = await pipeline.checkInbox();
    return json(res, 200, { ok: true, fresh: n });
  }

  let m = url.pathname.match(/^\/api\/jobs\/([a-f0-9]+)\/(\w+)$/);
  if (m && req.method === 'POST') {
    const job = d.jobs.find((j) => j.id === m[1]);
    if (!job) return json(res, 404, { error: 'الوظيفة مو موجودة.' });
    const act = m[2];
    if (act === 'send') {
      await mailer.sendJob(job);
      brief.dirty();
    } else if (act === 'skip') {
      job.status = 'skipped';
      store.event('info', `تجاهلت «${job.title}» في ${job.company}.`, job.id);
    } else if (act === 'restore') {
      job.status = job.draft ? (job.applyEmail ? 'ready' : 'manual') : 'new';
    } else if (act === 'done') {
      job.status = 'manual_done';
      job.sentAt = Date.now();
      store.event('ok', `سجّلت إنك قدّمت يدوياً على «${job.title}» في ${job.company}.`, job.id);
    } else if (act === 'edit') {
      if (job.sentAt) return json(res, 400, { error: 'انرسلت خلاص.' });
      if (typeof body.applyEmail === 'string') {
        const e = body.applyEmail.trim();
        if (e && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e)) return json(res, 400, { error: 'الإيميل مو صحيح.' });
        job.applyEmail = e;
        job.applyMethod = e ? 'email' : 'portal';
        if (job.draft && ['ready', 'manual', 'failed'].includes(job.status)) job.status = e ? 'ready' : 'manual';
      }
      if (job.draft && typeof body.subject === 'string' && body.subject.trim()) job.draft.subject = body.subject.replace(/[\r\n]+/g, ' ').trim();
      if (job.draft && typeof body.body === 'string' && body.body.trim()) job.draft.body = body.body.trim();
    } else if (act === 'draft') {
      await pipeline.withMain(`يكتب رسالة: ${job.title}`, async () => {
        try {
          job.draft = await draft.draftJob(job, 'application', { fresh: true });
          if (['new', 'low', 'failed'].includes(job.status)) job.status = job.applyEmail ? 'ready' : 'manual';
        } catch (e) {
          ai.reportAiError(e, 'كتابة الرسالة');
          throw e;
        }
      });
    } else if (act === 'followup') {
      if (!job.sentAt || !job.applyEmail) return json(res, 400, { error: 'ما في تقديم مرسل بالإيميل لهالوظيفة.' });
      if (body.send) {
        await mailer.sendJob(job, 'followup');
      } else {
        await pipeline.withMain(`يكتب متابعة: ${job.title}`, async () => {
          job.followUp = await draft.draftJob(job, 'followup');
        });
      }
    } else return json(res, 404, { error: 'أمر غير معروف.' });
    store.save();
    return json(res, 200, publicState());
  }

  m = url.pathname.match(/^\/api\/(problems|messages)\/([a-f0-9]+)\/(resolve|seen)$/);
  if (m && req.method === 'POST') {
    const item = d[m[1]].find((x) => x.id === m[2]);
    if (item) m[3] === 'resolve' ? (item.resolved = true) : (item.seen = true);
    store.save();
    return json(res, 200, publicState());
  }
  return json(res, 404, { error: 'غير موجود.' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname.startsWith('/api/')) {
      // كل طلب يخص حساب واحد: من الترويسة أو من ?a= في الرابط. بدونها = الحساب الرئيسي.
      const acct = String(req.headers['x-rasid-account'] || url.searchParams.get('a') || store.MAIN);
      if (!store.exists(acct)) return json(res, 404, { error: 'هالحساب مو موجود.', noAccount: true });
      return await store.within(acct, () => api(req, res, url));
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    json(res, 400, { error: String(e.message || e).slice(0, 300) });
  }
});

function openBrowser() {
  // بعد الإعداد: نافذة برنامج مستقلة. أثناء الإعداد: متصفحك العادي (تكون مسجّل في جوجل).
  win.open(!!store.load().config.setupDone);
}

if (require.main === module) {
  store.load();
  // ترقية: خطأ «حد الاستخدام» اللي انسجّل قبل كخطأ عام يتحول لتوقف مؤقت لين وقت الرجوع المكتوب فيه
  for (const p of store.load().problems) {
    if (p.key === 'claude-error' && !p.resolved && /hit your .{0,24}limit|session limit|usage limit/i.test(p.detail || '') && Date.now() - p.t < 6 * 3600000) {
      p.resolved = true;
      ai.reportAiError(new Error(p.detail), 'البحث');
    }
  }
  // يشتغل ٢٤ ساعة: أي خطأ غير متوقع ينسجّل ويكمّل بدل ما يطفي البرنامج
  process.on('uncaughtException', (e) => {
    console.error(new Date().toISOString(), 'uncaughtException', e);
    try { store.event('error', 'خطأ داخلي: ' + String(e.message).slice(0, 200)); } catch (_) {}
  });
  process.on('unhandledRejection', (e) => console.error(new Date().toISOString(), 'unhandledRejection', e));

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      // شغّال في الخلفية من قبل: نفتح اللوحة فقط
      console.log(`Rasid is already running. Opening http://127.0.0.1:${PORT}`);
      if (!process.env.RASID_NO_OPEN) openBrowser();
      setTimeout(() => process.exit(0), 1500);
    } else {
      console.error(e.message);
      process.exit(1);
    }
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log('\n  Rasid is running:  http://127.0.0.1:' + PORT + '\n  Stop with Ctrl+C.\n');
    pipeline.startScheduler();
    // يشيّك على التحديثات عند التشغيل وكل ٥ دقايق. التحديث إجباري: يوقف اللي شغّال، يركّب، ويرجع يشتغل في ثواني
    const upd = () => update.auto(updateHooks).catch((e) => console.error(new Date().toISOString(), 'update', e.message));
    setTimeout(upd, 8000);
    setInterval(upd, 5 * 60000).unref?.();
    if (!process.env.RASID_NO_OPEN) openBrowser();
  });
  const bye = () => {
    store.saveNow();
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

module.exports = { server, publicState };
