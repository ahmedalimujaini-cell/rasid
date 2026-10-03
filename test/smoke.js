// اختبار المسار كامل بدون إنترنت: بحث ← صياغة ← إرسال (SMTP محلي) ← ردود ← حماية الـAPI.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rasid-'));
process.env.RASID_DATA = tmp;
process.env.RASID_MOCK = '1';
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const store = require('../src/store');
const pipeline = require('../src/pipeline');
const mailer = require('../src/mailer');
const inbox = require('../src/inbox');
const ai = require('../src/ai');
const { server } = require('../src/server');

const got = [];
const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onAuth: (a, s, cb) => cb(null, { user: a.username }),
  onData(stream, s, cb) {
    simpleParser(stream).then((m) => (got.push(m), cb()));
  },
});
let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  passed++;
  console.log('  ✓ ' + name);
};

(async () => {
  await new Promise((r) => smtp.listen(2526, '127.0.0.1', r));
  const d = store.load();
  Object.assign(d.config, { setupDone: true, smtp: { host: '127.0.0.1', port: 2526, secure: false, ignoreTLS: true } });
  d.config.gmail = { user: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop' };
  d.config.profile.name = 'Test User';
  d.config.mode = 'review';
  const brief = require('../src/brief');

  // JSON parsing
  ok('extractJson: fenced', ai.extractJson('text\n```json\n{"a":1}\n```\nmore').a === 1);
  ok('extractJson: bare with prose', ai.extractJson('Here: {"a":[1,2]} done').a.length === 2);
  assert.throws(() => ai.extractJson('no json here'));

  // review mode cycle
  const byCo = (c) => d.jobs.find((j) => j.company === c);
  const byCoName = byCo;
  let r = await pipeline.cycle();

  // المحادثة داخل البرنامج
  const chat = require('../src/chat');
  let drafted = 0;
  const deps = { applyConfig: (v) => Object.assign(d.config, v), briefDirty() {}, busy: () => '', run: { inbox: async () => 2 }, draftNow: () => drafted++ };
  const firstId = d.jobs[0].id;
  let c = await chat.handle('قصّر رسالة أول وظيفة', deps);
  ok('chat edits an unsent draft', c.done.length === 1 && d.jobs[0].draft.body.includes('Short version') && d.jobs[0].draft.subject === 'Shorter subject');
  c = await chat.handle('خرّب كل شي', deps);
  ok('chat: unknown action + non-whitelisted setting + bad email all refused', c.failed.length === 2 && c.done.length === 1 && d.config.claudePath === 'claude' && d.config.dailyCap === 3 && d.jobs.find((j) => j.id === firstId).applyEmail !== 'bad address');
  d.config.dailyCap = 8;
  await chat.handle('ملاحظة لكل الرسائل: خلها قصيرة', deps);
  ok('chat saves a standing letter note + keeps history', d.config.letterNotes === 'Keep it under 150 words.' && d.chat.length === 6 && d.chat[0].who === 'me');
  c = await chat.handle('ضيف هذا الإيميل hr@sohar-lift.example شركة Sohar Lift', deps);
  ok('chat adds a company by the email he typed; an address he did not type is refused', c.done.length === 1 && c.failed.length === 1 && drafted === 1 && d.jobs[0].company === 'Sohar Lift Co' && d.jobs[0].applyEmail === 'hr@sohar-lift.example' && !d.jobs.some((j) => j.company === 'Injected Co'));
  d.jobs.shift();
  c = await chat.handle('تأكد من الوظيفة الأولى', deps);
  ok('chat cannot send unless he explicitly says send', c.failed.length === 1 && got.length === 0);
  c = await chat.handle('اقرا عن شركة Galfar وقل لي رأيك', deps);
  ok('chat: fast tier escalates research to the full tier', c.reply === 'شركة زينة وتستاهل.' && c.failed.length === 0);
  ok('partial reply is extracted from a half-written JSON answer', chat.partialReply('```json\n{"reply":"تمام يا أحمد، قدّ') === 'تمام يا أحمد، قدّ' && chat.partialReply('{"reply":"سطر\\nثاني","act') === 'سطر\nثاني' && chat.partialReply('{"rep') === '');
  c = await chat.handle('شيّك على الإيميل', deps);
  ok('instant: "check the email" runs the inbox check without calling Claude', c.reply.includes('فحصت الإيميل') && c.done.length === 1);
  c = await chat.handle('ايش الجديد؟', deps);
  ok('instant: status answered locally from real counts', /قدّمت لين الحين على \d+/.test(c.reply) && c.done.length === 0);
  ok('instant: longer or unrelated messages still go to Claude', chat.instant(d, 'اقرا عن شركة Galfar وقل لي رأيك وشيّك على الإيميل بعدها لو سمحت') === null && chat.instant(d, 'قصّر الرسالة') === null);
  const A = ai.buildArgs;
  ok('lean flags: no-tool fast call uses haiku + empty tool list; web call lists only web tools', A({ tools: [], fast: true }, 0).join(' ').endsWith('--tools  --model haiku') && A({ tools: ['WebSearch', 'WebFetch'] }, 0).includes('WebSearch,WebFetch') && !A({ tools: [] }, 2).includes('--tools'));
  ok('"check email" runs inbox and reports the count', (await chat.execute({ type: 'run', what: 'inbox' }, d, deps, '')).includes('2 ردود'));
  ok('discovery: dedupes + drops no-URL job; company scan adds 3 (8 kept)', d.jobs.length === 8 && r.found === 8);
  const spec = byCoName('Batinah Builders');
  ok('company scan: speculative application with the published email is ready to send', spec.kind === 'speculative' && spec.status === 'ready' && spec.title.startsWith('Speculative application'));
  ok('company scan: no email → manual with apply steps; unverified email discarded; already-emailed company skipped', byCoName('Form Only Co').status === 'manual' && byCoName('Form Only Co').applySteps.includes('Careers') && byCoName('Guessed Email Co').applyEmail === '' && d.jobs.filter((j) => j.company === 'Test Operator LLC').length === 1 && d.state.dirIndex === 2);
  ok('email job drafted → ready', byCo('Test Operator LLC').status === 'ready');
  ok('portal job drafted → manual', byCo('Portal Only Co').status === 'manual' && byCo('Portal Only Co').draft);
  ok('invalid apply email dropped, low fit not drafted', byCo('Ledger Co').applyEmail === '' && byCo('Ledger Co').status === 'low');
  ok('unverified posting: email discarded, manual only', byCo('Unopened Co').applyEmail === '' && byCo('Unopened Co').status === 'manual');
  ok('review mode sent nothing', got.length === 0 && r.sent === 0);

  // sending blocked without CV
  await assert.rejects(mailer.sendJob(byCo('Test Operator LLC')));
  ok('no CV → blocked + problem raised', d.problems.some((p) => p.key === 'cv-missing' && !p.resolved) && got.length === 0);

  fs.writeFileSync(path.join(tmp, 'cv.pdf'), Buffer.alloc(2000, 1));
  d.config.cv = { file: 'cv.pdf', originalName: 'Test_CV.pdf', text: '' };
  await mailer.sendJob(byCo('Test Operator LLC'));
  ok('manual send delivers with CV attached', got.length === 1 && got[0].attachments[0].filename === 'Test_CV.pdf' && got[0].to.text === 'careers@test-operator.example');
  ok('job marked sent with messageId', byCo('Test Operator LLC').status === 'sent' && !!byCo('Test Operator LLC').messageId);
  await assert.rejects(mailer.sendJob(byCo('Test Operator LLC')));
  ok('never applies twice to same job', got.length === 1);

  // auto mode + daily cap
  d.config.mode = 'auto';
  d.config.dailyCap = 3;
  r = await pipeline.cycle();
  ok('auto mode sends remaining ready jobs incl. speculative, stops at daily cap', got.length === 3 && byCo('Lift Services').status === 'sent' && byCo('Batinah Builders').status === 'sent');
  ok('second cycle adds no duplicates', d.jobs.length === 8);

  // replies
  const job = byCo('Test Operator LLC');
  let n = await inbox.processMessages([
    { messageId: '<r1@x>', inReplyTo: job.messageId, references: [], from: 'hr@test-operator.example', fromName: 'HR', subject: 'Re: Application', date: Date.now(), text: 'We would like to invite you to an interview next week.' },
    { messageId: '<n1@x>', inReplyTo: '', references: [], from: 'news@shop.example', fromName: 'Shop', subject: 'Big sale', date: Date.now(), text: 'Buy now' },
    { messageId: '<me@x>', inReplyTo: '', references: [], from: 'me@gmail.com', fromName: '', subject: 'application', date: Date.now(), text: 'x' },
  ]);
  ok('reply linked to job by thread, unrelated mail ignored', n === 1 && d.messages[0].jobId === job.id && d.messages[0].category === 'interview');
  n = await inbox.processMessages([{ messageId: '<r1@x>', inReplyTo: job.messageId, references: [], from: 'hr@test-operator.example', fromName: 'HR', subject: 'Re', date: Date.now(), text: 'interview' }]);
  ok('same reply not stored twice', n === 0 && d.messages.length === 1);
  const j2 = byCo('Lift Services');
  await inbox.processMessages([{ messageId: '<b1@x>', inReplyTo: '', references: [], from: 'mailer-daemon@googlemail.com', fromName: 'Mail Delivery Subsystem', subject: 'Delivery Status Notification (Failure)', date: Date.now(), text: 'Address not found: hr@lift-services.example' }]);
  ok('bounce → job failed + problem', j2.status === 'failed' && d.problems.some((p) => p.key === 'bounce-' + j2.id));
  await inbox.processMessages([{ messageId: '<d1@x>', inReplyTo: '', references: [], from: 'someone@test-operator.example', fromName: 'TA', subject: 'Your application', date: Date.now(), text: 'thank you for applying' }]);
  ok('reply matched by company domain', d.messages[0].jobId === job.id);

  // follow-up + news + cv
  await new Promise((res) => setTimeout(res, 10));
  job.followUp = await require('../src/draft').draftJob(job, 'followup');
  await mailer.sendJob(job, 'followup');
  ok('follow-up threads onto original, no attachment', got[got.length - 1].inReplyTo === job.messageId && got[got.length - 1].attachments.length === 0);
  await pipeline.news();
  ok('news keeps only items with URL', d.news.length === 1);

  // الموجز الصوتي
  ok('default mode is auto for new installs', fs.readFileSync(path.join(__dirname, '..', 'src', 'store.js'), 'utf8').includes("mode: 'auto'"));
  ok('cycle marks brief dirty', d.state.briefDirty === true);
  let b = await brief.onOpen();
  ok('brief generated on open, unheard', b.text.includes('يا أحمد') && b.heard === false && d.state.briefDirty === false);
  ok('same unheard brief returned again (no regeneration)', (await brief.onOpen()).at === b.at);
  brief.heard();
  ok('heard → remembered', d.brief.heard && d.state.lastBriefHeard === b.at);
  ok('nothing new → no regeneration within 6h', (await brief.onOpen()).at === b.at);
  d.problems.forEach((p) => (p.resolved = true));
  d.messages.forEach((m) => ((m.seen = true), (m.date = 1)));
  d.state.lastBriefHeard = Date.now() - 7 * 3600000;
  d.jobs.forEach((j) => { j.sentAt = j.sentAt && 1; j.foundAt = 1; });
  d.config.profile.nickname = 'أحمد';
  b = await brief.onOpen();
  ok('next day, nothing new → short spoken greeting by nickname', b.empty && b.text.startsWith('يا أحمد، ما في شي جديد'));
  ok('fallback script lists applications without AI', brief.fallback('أحمد', { sent: [{ title: 'ESP Lead', company: 'X', companyAbout: 'شركة في صحار' }], waiting: [], replies: [], problems: [] }).includes('ESP Lead في X، شركة في صحار'));

  // ملخص الإيميل الدوري
  const digest = require('../src/digest');
  d.state.lastDigest = 0;
  d.config.digestEveryHours = 12;
  ok('digest is due after the interval', digest.due() === true);
  const before = got.length;
  d.problems.unshift({ id: 'zz', key: 'x', t: Date.now(), text: 'مشكلة اختبار', fix: '', resolved: false });
  ok('digest emails the summary to his own address', (await digest.run()) === true && got.length === before + 1 && got[got.length - 1].subject.startsWith('راصد:') && got[got.length - 1].to.text === 'me@gmail.com' && digest.due() === false);
  d.problems.shift();
  d.config.digestEveryHours = 0;
  ok('digest off when set to 0', digest.due() === false);

  // تشخيص أخطاء Claude
  ai.reportAiError(new Error('CLAUDE_ERROR: Not logged in · Please run /login'), 'البحث');
  ok('real auth error → auth problem with raw text', d.problems.some((p) => p.key === 'claude-auth' && !p.resolved && p.detail.includes('Not logged in')));
  ai.reportAiError(new Error('CLAUDE_EXIT_1: something about authors and logins page failed'), 'البحث');
  ok('unrelated error is not mislabelled as login', d.problems.filter((p) => p.key === 'claude-error' && !p.resolved).length === 1);
  await ai.selfTest();
  ok('self-test clears Claude problems', !d.problems.some((p) => /^claude-/.test(p.key) && !p.resolved));

  // API guard
  await new Promise((res) => server.listen(4799, '127.0.0.1', res));
  const base = 'http://127.0.0.1:4799';
  let resp = await fetch(base + '/api/config', { method: 'POST', body: JSON.stringify({ mode: 'review' }) });
  ok('POST without X-Rasid header → 403', resp.status === 403);
  resp = await fetch(base + '/api/config', { method: 'POST', headers: { 'X-Rasid': '1' }, body: JSON.stringify({ mode: 'review', dailyCap: 999 }) });
  const st = await resp.json();
  ok('config saved, values clamped, password never returned', st.config.mode === 'review' && st.config.dailyCap === 30 && !('appPassword' in st.config.gmail) && st.config.gmail.hasPassword);
  resp = await fetch(base + '/../src/store.js');
  ok('static path traversal blocked', resp.status === 404);

  // التحديث الذاتي: مصدر محلي يقلّد المستودع
  const http = require('http');
  const crypto = require('crypto');
  const update = require('../src/update');
  const ROOT = path.join(__dirname, '..');
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const mine = update.local();
  const original = fs.readFileSync(path.join(ROOT, 'README.md'));
  const newReadme = Buffer.concat([original, Buffer.from('\n<!-- update test -->\n')]);
  const current = Object.fromEntries(Object.keys(mine.files).filter((f) => fs.existsSync(path.join(ROOT, f))).map((f) => [f, sha(fs.readFileSync(path.join(ROOT, f)))]));
  let remote = { build: mine.build + 1, notes: 'اختبار', files: { ...current, 'README.md': sha(newReadme) } };
  let serveReadme = newReadme;
  const repo = http.createServer((q, r2) => {
    const u = q.url.split('?')[0];
    if (u === '/version.json') return r2.end(JSON.stringify(remote));
    if (u === '/README.md') return r2.end(serveReadme);
    if (u === '/src/evil.js') return r2.end('this is ( not js');
    r2.statusCode = 404;
    r2.end();
  });
  await new Promise((res) => repo.listen(4798, '127.0.0.1', res));
  process.env.RASID_UPDATE_BASE = 'http://127.0.0.1:4798';
  process.env.RASID_NO_RESTART = '1';
  const savedVersion = fs.readFileSync(path.join(ROOT, 'version.json'));
  try {
    ok('update check finds the newer build with its notes', (await update.check()).build === mine.build + 1 && d.state.update.notes === 'اختبار');
    serveReadme = Buffer.from('tampered');
    await assert.rejects(update.install(), /التوقيع/);
    ok('tampered file rejected, nothing changed', fs.readFileSync(path.join(ROOT, 'README.md')).equals(original) && update.local().build === mine.build);
    remote.files['src/evil.js'] = sha(Buffer.from('this is ( not js'));
    serveReadme = newReadme;
    await assert.rejects(update.install(), /خطأ في src\/evil\.js/);
    ok('update with broken JS refused before touching the running copy', !fs.existsSync(path.join(ROOT, 'src', 'evil.js')) && fs.readFileSync(path.join(ROOT, 'README.md')).equals(original));
    delete remote.files['src/evil.js'];
    remote.files['../outside.txt'] = 'x';
    await assert.rejects(update.install(), /مسار غير مسموح/);
    delete remote.files['../outside.txt'];
    const out = await update.install();
    ok('good update installs only the changed file, bumps build, keeps a backup', out.updated && out.files === 1 && update.local().build === mine.build + 1 && fs.readFileSync(path.join(ROOT, 'README.md')).equals(newReadme) && fs.existsSync(path.join(tmp, 'backup', String(mine.build), 'README.md')) && d.state.update === null);
    ok('already up to date → no-op', (await update.install()).updated === false);
  } finally {
    fs.writeFileSync(path.join(ROOT, 'README.md'), original);
    fs.writeFileSync(path.join(ROOT, 'version.json'), savedVersion);
    repo.close();
    delete process.env.RASID_UPDATE_BASE;
  }

  console.log(`\n${passed} فحص نجح.`);
  server.close();
  smtp.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => {
  console.error('\nFAILED:', e.message);
  process.exit(1);
});
