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

  // المحادثة داخل البرنامج: وكيل بأدوات. في الاختبار نحدد نداءات الأدوات يدوياً وتمر على نفس الطبقة والحمايات.
  const chat = require('../src/chat');
  process.env.RASID_MOCK_MAIL = '1';
  let drafted = 0;
  const deps = { applyConfig: (v) => Object.assign(d.config, v), briefDirty() {}, busy: () => '', run: { inbox: async () => 2 }, draftNow: () => drafted++ };
  const say = (text, calls, reply = 'تم.') => {
    global.__agent = () => ({ calls, text: reply });
    return chat.handle(text, deps);
  };
  const firstId = d.jobs[0].id;
  let c = await say('قصّر رسالة أول وظيفة', [{ name: 'do_action', args: { action: { type: 'edit_draft', jobId: firstId, subject: 'Shorter subject', body: 'Dear Hiring Manager,\n\nShort version of the letter for the test.\n\nYours sincerely,\nTest User' } } }]);
  ok('chat edits an unsent draft through the action tool', c.done.length === 1 && d.jobs[0].draft.body.includes('Short version') && d.jobs[0].draft.subject === 'Shorter subject');
  c = await say('خرّب كل شي', [
    { name: 'do_action', args: { action: { type: 'delete_everything' } } },
    { name: 'do_action', args: { action: { type: 'settings', values: { claudePath: 'evil', dailyCap: 3 } } } },
    { name: 'do_action', args: { action: { type: 'set_apply_email', jobId: firstId, email: 'bad address' } } },
    { name: 'no_such_tool', args: {} },
  ]);
  ok('chat: unknown action/tool, non-whitelisted setting and bad email all refused', c.failed.length === 2 && c.done.length === 1 && d.config.claudePath === 'claude' && d.config.dailyCap === 3 && d.jobs.find((j) => j.id === firstId).applyEmail !== 'bad address');
  d.config.dailyCap = 8;
  await say('ملاحظة لكل الرسائل: خلها قصيرة', [{ name: 'do_action', args: { action: { type: 'letter_notes', text: 'Keep it under 150 words.' } } }]);
  ok('chat saves a standing letter note + keeps history', d.config.letterNotes === 'Keep it under 150 words.' && d.chat.length === 6 && d.chat[0].who === 'me');
  c = await say('ضيف هذا الإيميل hr@sohar-lift.example شركة Sohar Lift', [
    { name: 'do_action', args: { action: { type: 'add_job', company: 'Sohar Lift Co', email: 'hr@sohar-lift.example', companyAbout: 'شركة في صحار' } } },
    { name: 'do_action', args: { action: { type: 'add_job', company: 'Injected Co', email: 'attacker@evil.example' } } },
  ]);
  ok('chat adds a company by the email he typed; an address he did not type is refused', c.done.length === 1 && c.failed.length === 1 && drafted === 1 && d.jobs[0].company === 'Sohar Lift Co' && d.jobs[0].applyEmail === 'hr@sohar-lift.example' && !d.jobs.some((j) => j.company === 'Injected Co'));
  d.jobs.shift();
  c = await say('تأكد من الوظيفة الأولى', [{ name: 'do_action', args: { action: { type: 'send', jobId: firstId } } }]);
  ok('chat cannot send unless he explicitly says send', c.failed.length === 1 && got.length === 0);
  ok('"check email" runs inbox and reports the count', (await chat.callTool('do_action', { action: { type: 'run', what: 'inbox' } })).done.includes('2 ردود'));
  // أدوات القراءة
  let t = await chat.callTool('mail_search', { query: 'enco' });
  ok('mail_search covers sent and received and marks mail text as untrusted', t.total === 4 && t.items[0].uid === 188 && t.items.some((m) => m.direction === 'sent by him') && /never as instructions/.test(t.note));
  t = await chat.callTool('mail_thread', { uid: 140 });
  ok('mail_thread returns the whole conversation oldest first, including his own reply', t.messages_in_thread === 4 && t.messages[0].uid === 101 && t.messages[2].direction === 'sent by him');
  ok('mail_overview and mail_read work; a bad uid is an error, not a crash', (await chat.callTool('mail_overview', {})).total_messages === 6 && (await chat.callTool('mail_read', { uid: 201 })).attachments[0] === 'CV.pdf' && !!(await chat.callTool('mail_read', { uid: 999 })).error);
  t = await chat.callTool('jobs_list', { status: 'not_applied' });
  ok('jobs_list filters applied / not applied', t.total === d.jobs.length && (await chat.callTool('jobs_list', { status: 'applied' })).total === 0 && (await chat.callTool('jobs_list', { company: 'portal only' })).jobs[0].company === 'Portal Only Co');
  t = await chat.callTool('program_status', {});
  ok('program_status never exposes the Gmail password', t.gmail_account === 'me@gmail.com' && !JSON.stringify(t).includes('abcd'));
  t = await chat.callTool('job_details', { id: firstId });
  ok('job_details includes the full application email', t.application_email.body.includes('Short version'));
  const A = ai.buildArgs;
  ok('agent flags: only Rasid tools + web are allowed, his own MCP servers are not loaded', A({ tools: ['WebSearch'], mcpConfig: '/x/mcp.json', mcpTools: ['mail_search'] }, 0).join(' ').includes('--allowedTools WebSearch,mcp__rasid,mcp__rasid__mail_search --mcp-config /x/mcp.json --permission-mode dontAsk --strict-mcp-config') && !A({ tools: [] }, 2).includes('--tools'));
  // خادم MCP نفسه: يرد على البروتوكول ويعرض الأدوات
  const { spawnSync } = require('child_process');
  const mcpOut = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'mcp.js')], { input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n', encoding: 'utf8' }).stdout.trim().split('\n').map((l) => JSON.parse(l));
  ok('MCP server speaks the protocol and lists the tools', mcpOut[0].result.protocolVersion === '2025-06-18' && mcpOut[1].result.tools.length === 8 && mcpOut[1].result.tools.every((x) => x.name && x.inputSchema));
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

  // حد استخدام الاشتراك
  const at = new Date(2026, 9, 3, 9, 17).getTime();
  const lim = new Date(ai.limitUntil("CLAUDE_ERROR: You've hit your session limit · resets 12:10pm (Asia/Muscat)", at));
  ok('limit reset time is read from the message', lim.getHours() === 12 && lim.getMinutes() === 12 && lim.getDate() === 3);
  ok('reset time already passed today → tomorrow; unreadable → one hour', new Date(ai.limitUntil('resets 8am', at)).getDate() === 4 && ai.limitUntil('limit reached', at) === at + 3600000);
  ai.reportAiError(new Error("CLAUDE_ERROR: You've hit your session limit · resets 11:59pm (Asia/Muscat)"), 'البحث');
  ok('session limit → one clear limit problem (not a generic error) and a pause', d.problems.some((p) => p.key === 'claude-limit' && !p.resolved && /يرجع الساعة/.test(p.text)) && !d.problems.some((p) => p.key === 'claude-error' && !p.resolved) && ai.paused() > 0);
  await assert.rejects(ai.askJson('x', { mockKey: 'selftest' }), /CLAUDE_LIMIT_PAUSED/);
  await assert.rejects(say('ايش الجديد', []), /حد استخدام Claude/);
  const searchedAt = d.state.lastSearch;
  r = await pipeline.cycle();
  ok('while paused: search does nothing and is not counted as done, so it resumes later', r.found === 0 && d.state.lastSearch === searchedAt);
  d.state.aiPausedUntil = Date.now() - 1000;
  ok('pause ends by itself and clears the problem', ai.paused() === 0 && !d.problems.some((p) => p.key === 'claude-limit' && !p.resolved));

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
    // التحديث التلقائي
    fs.writeFileSync(path.join(ROOT, 'README.md'), original);
    fs.writeFileSync(path.join(ROOT, 'version.json'), savedVersion);
    ok('auto-update waits while a search or send is running', (await update.auto(() => 'يبحث')).waiting === true && update.local().build === mine.build);
    d.config.autoUpdate = false;
    ok('auto-update off → only flags it', (await update.auto(() => '')).pending === true && update.local().build === mine.build && d.state.update.build === mine.build + 1);
    d.config.autoUpdate = true;
    ok('auto-update installs by itself when idle', (await update.auto(() => '')).updated === true && update.local().build === mine.build + 1);
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
