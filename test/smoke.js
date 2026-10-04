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
  ok('new installs: send by themselves, search once a day at 10, daily target 20', d.config.autoAI === true && d.config.mode === 'auto' && d.config.searchHour === 10 && d.config.dailyCap === 20);
  const at10 = pipeline.slot(Date.now(), 10);
  ok('daily search: not before 10:00, due after it (and still due later the same day if the PC was off)', pipeline.due(d, at10 - 60000) === null && pipeline.due(d, at10 + 60000) === 'cycle' && pipeline.due(d, at10 + 9 * 3600000) === 'cycle');
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
  const mockCalls = require('./mock').calls;
  ok('speculative letters: one base letter per role (3 companies, 2 roles → 2 AI calls), filled with each company name', mockCalls['draft:specbase'] === 2 && spec.draft.fromBase && spec.draft.body.includes('role at Batinah Builders') && byCo('Form Only Co').draft.body.includes('role at Form Only Co') && byCo('Guessed Email Co').draft.fromBase && !spec.draft.body.includes('{{') && Object.keys(d.state.specLetters).length === 2);
  const realAsk = ai.askJson;
  ai.askJson = async (pr, o) => (o.mockKey === 'draft:specbase' ? { subject: 's', body: 'A base letter that forgot the company placeholder entirely, long enough.' } : realAsk(pr, o));
  d.state.specLetters = {};
  const fb = await require('../src/draft').draftJob({ title: 'Speculative application – Estimator', company: 'Fallback Co', kind: 'speculative', requirements: '', location: '' });
  ai.askJson = realAsk;
  ok('a bad base letter falls back to a letter written for that company', !fb.fromBase && fb.body.length > 40);
  ok('company scan: no email → manual with apply steps; unverified email discarded; already-emailed company skipped', byCoName('Form Only Co').status === 'manual' && byCoName('Form Only Co').applySteps.includes('Careers') && byCoName('Guessed Email Co').applyEmail === '' && d.jobs.filter((j) => j.company === 'Test Operator LLC').length === 1 && d.state.dirIndex === 5);
  ok('the daily run went through its whole plan (target not reached) and is done for today', d.state.run.done && d.state.run.steps.length === 9 && pipeline.due(d, at10 + 60000) === null);
  ok('search passes use Sonnet, the company scan uses Haiku, letters use Sonnet with low effort', require('./mock').models['discover:employers'] === 'sonnet/medium' && require('./mock').models.directory === 'haiku/low' && require('./mock').models['draft:application'] === 'sonnet/low');
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
  const briefCalls = require('./mock').calls.brief || 0;
  let b = await brief.onOpen();
  ok('brief generated on open from the numbers (no Claude), unheard', b.text.startsWith('يا Test،') && b.heard === false && d.state.briefDirty === false && (require('./mock').calls.brief || 0) === briefCalls);
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

  // الوضع اليدوي: ما في أي نداء لـClaude بدون أمر
  const MC = require('./mock').calls;
  d.config.autoAI = false;
  const savedRun = d.state.run;
  d.state.run = null;
  ok('manual mode: the scheduler starts no search and no news', pipeline.due(d, at10 + 60000) === null);
  d.config.autoAI = true;
  ok('automatic mode: the daily search is due', pipeline.due(d, at10 + 60000) === 'cycle');
  d.state.run = savedRun;
  d.config.autoAI = false;
  const before2 = { classify: MC.classify || 0, brief: MC.brief || 0 };
  await inbox.processMessages([{ messageId: '<m9@x>', inReplyTo: '', references: [], from: 'hr@test-operator.example', fromName: 'HR', subject: 'Interview invitation', date: Date.now(), text: 'We would like to invite you to an interview on Monday.' }]);
  ok('manual mode: a new reply is classified by keywords without calling Claude', (MC.classify || 0) === before2.classify && d.messages[0].category === 'interview' && d.messages[0].summary.includes('interview on Monday'));
  d.state.lastBriefHeard = 0;
  const auto1 = await brief.compose(0);
  const forced = await brief.compose(0, false, true);
  ok('manual mode: brief and email summary are built from the numbers; asking for a fresh brief uses Claude', (MC.brief || 0) === before2.brief + 1 && !auto1.nothing && auto1.text.length > 20 && forced.text.includes('يا أحمد'));
  d.messages[0].seen = true;
  d.config.autoAI = true;

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

  // الحد انفك قبل الوقت المكتوب: أمر منك يجرّب فعلياً ولا ينتظر
  ai.reportAiError(new Error("CLAUDE_ERROR: You've hit your session limit · resets 11:59pm (Asia/Muscat)"), 'البحث');
  ok('paused before your command', ai.paused() > 0);
  ai.resume();
  ok('your command lifts a stale pause and its problem', ai.paused() === 0 && !d.problems.some((p) => p.key === 'claude-limit' && !p.resolved));
  await ai.askJson('x', { mockKey: 'selftest' });

  // البحث اليومي: يوقف أول ما يكتمل هدف اليوم، ويكمّل من حيث وقف بعد حد الاستخدام أو التحديث
  {
    const realAsk = ai.askJson;
    const research = [];
    let n = 0;
    let failNext = '';
    let gate = null;
    const isResearch = (o) => o.mockKey && (o.mockKey.startsWith('discover:') || o.mockKey === 'directory');
    ai.askJson = async (pr, o) => {
      if (!isResearch(o)) return realAsk(pr, o);
      research.push(o.mockKey);
      if (gate) {
        await gate.wait;
        if (ai.stopRequested()) throw new Error('CLAUDE_STOPPED: x');
      }
      if (failNext) {
        const m = failNext;
        failNext = '';
        throw new Error(m);
      }
      n++;
      if (o.mockKey === 'directory') return { companies: [{ company: 'Daily Co ' + n, url: 'https://example.com/d' + n, applyEmail: `hr${n}@daily.example`, verified: true, fit: 90, suggestedRole: 'Junior Quantity Surveyor' }] };
      return { jobs: [{ title: 'Daily Role ' + n, company: 'Daily Vacancy ' + n, url: 'https://example.com/v' + n, applyEmail: `jobs${n}@vacancy.example`, fit: 90, requirements: 'x' }] };
    };
    const needs = (k) => (d.config.dailyCap = d.config.dailyCap - pipeline.need(d) + k);
    const hold = () => {
      let open;
      gate = { wait: new Promise((res) => (open = res)) };
      gate.open = () => {
        const g = gate;
        gate = null;
        open();
        return g;
      };
    };
    const reached = async (len) => {
      for (let i = 0; i < 200 && research.length < len; i++) await new Promise((res) => setTimeout(res, 5));
    };
    d.config.mode = 'review';

    d.state.run = null;
    needs(2);
    r = await pipeline.cycle();
    ok('daily target reached after two search steps → stops searching, the day is done', research.length === 2 && r.found === 2 && d.state.run.done && d.state.run.steps.length === 2 && pipeline.need(d) <= 0 && pipeline.due(d, at10 + 60000) === null);
    ok('the first search step changes every search day', research[0] === 'discover:boards' && d.state.run.rot === 1);

    d.state.run = null;
    research.length = 0;
    needs(3);
    failNext = "CLAUDE_ERROR: You've hit your session limit · resets 11:59pm (Asia/Muscat)";
    r = await pipeline.cycle();
    ok('Claude limit mid-search: it pauses, nothing is marked done, the scheduler waits', research.length === 1 && !d.state.run.done && d.state.run.steps.length === 0 && ai.paused() > 0 && pipeline.due(d, at10 + 60000) === null);
    ai.resume();
    ok('when the limit is back the day\'s search is due again', pipeline.due(d, at10 + 60000) === 'cycle');
    r = await pipeline.cycle();
    ok('...and it carries on from where it stopped until the target is reached', research.length === 4 && research[1] === research[0] && d.state.run.done && d.state.run.steps.length === 3);

    // وقّفته أنت: خلاص لليوم (لو وقت البحث فات)
    d.state.run = null;
    research.length = 0;
    needs(5);
    hold();
    let running = pipeline.cycle();
    await reached(1);
    ok('stop button works on a running daily search', pipeline.stop() === true);
    gate.open();
    await running;
    ok('stopped by you → not restarted by itself today', !!d.state.run.userStopAt && !d.state.run.done && pipeline.due(d, at10 + 60000) === (Date.now() >= at10 ? null : 'cycle'));

    // التحديث: يوقف كل شي، وما يبدأ شي جديد، وبعد ما يرجع البرنامج يكمّل البحث من حيث وقف
    d.state.run = null;
    research.length = 0;
    hold();
    running = pipeline.cycle();
    await reached(1);
    const frozen = pipeline.freeze(5000);
    const g = gate.open();
    await frozen;
    await running;
    ok('an update stops the search, waits for it and blocks new work', pipeline.status.frozen && !pipeline.status.main && !!g);
    await assert.rejects(pipeline.cycle(), /يتحدّث/);
    ok('...and the day resumes right after the restart (not counted as your stop, no wait)', !d.state.run.done && !d.state.run.userStopAt && !d.state.run.retryAt && pipeline.due(d, at10 + 60000) === 'cycle');
    pipeline.unfreeze();
    ok('if the install fails, the program carries on', !pipeline.status.frozen && !ai.stopRequested());

    // Claude مو موجود: مشكلة وحدة واضحة، ويجرب بعد ساعة بدل كل ٣٠ ثانية
    d.state.run = null;
    failNext = 'CLAUDE_NOT_FOUND: spawn claude ENOENT';
    await pipeline.cycle();
    const rt = d.state.run.retryAt;
    ok('Claude missing → one clear problem and a retry in an hour', d.problems.some((p) => p.key === 'claude-missing' && !p.resolved) && rt > Date.now() + 50 * 60000);
    d.state.run.retryAt = at10 + 3600000;
    ok('...the scheduler waits for that hour', pipeline.due(d, at10 + 60000) === null && pipeline.due(d, at10 + 3600000 + 1) === 'cycle');
    r = await pipeline.cycle();
    ok('the next try clears the old Claude problem by itself when Claude works again', !d.problems.some((p) => p.key === 'claude-missing' && !p.resolved) && d.state.run.done);

    // الإرسال التلقائي يرسل اللي جاهز بفاصل، ويوقف عند هدف اليوم
    ai.askJson = realAsk;
    d.config.mode = 'auto';
    const sentBefore = got.length;
    d.config.dailyCap = mailer.sentToday(d) + 2;
    const sentNow = await pipeline.autoSend();
    ok('auto mode sends without asking, up to the daily target', sentNow === 2 && got.length === sentBefore + 2 && mailer.sentToday(d) === d.config.dailyCap);
    const twin = { ...d.jobs.find((j) => j.status === 'ready' && j.applyEmail), sendingAt: Date.now() };
    await assert.rejects(mailer.sendJob(twin), /ينرسل الحين/);
    ok('the same application cannot be sent twice at the same moment', got.length === sentBefore + 2);
    d.config.dailyCap = 8;
  }

  // زر «وقّف»: يقتل Claude الشغّال فوراً، وما يطلع كمشكلة
  {
    const fake = path.join(process.env.RASID_DATA, 'slowclaude.sh');
    fs.writeFileSync(fake, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    const oldPath = d.config.claudePath;
    d.config.claudePath = fake;
    delete process.env.RASID_MOCK;
    const t0 = Date.now();
    const run = ai.askJson('x', { tools: [], timeoutMs: 60000 });
    setTimeout(() => ai.stopAll(), 300);
    await assert.rejects(run, /CLAUDE_STOPPED/);
    ok('stop kills a running Claude within seconds', Date.now() - t0 < 5000 && ai.stopRequested());
    await assert.rejects(ai.askJson('x', {}), /CLAUDE_STOPPED/);
    const nProb = d.problems.length;
    ai.reportAiError(new Error('CLAUDE_STOPPED: x'), 'البحث');
    ok('a stop is not reported as a problem', d.problems.length === nProb);
    ai.clearStop();
    process.env.RASID_MOCK = '1';
    d.config.claudePath = oldPath;
    ok('stop with nothing running does nothing', pipeline.stop() === false && !ai.stopRequested());
  }

  // تشخيص أخطاء Claude
  ai.reportAiError(new Error('CLAUDE_ERROR: Not logged in · Please run /login'), 'البحث');
  ok('real auth error → auth problem with raw text', d.problems.some((p) => p.key === 'claude-auth' && !p.resolved && p.detail.includes('Not logged in')));
  ai.reportAiError(new Error('CLAUDE_EXIT_1: something about authors and logins page failed'), 'البحث');
  ok('unrelated error is not mislabelled as login', d.problems.filter((p) => p.key === 'claude-error' && !p.resolved).length === 1);
  await ai.selfTest();
  ok('self-test clears Claude problems', !d.problems.some((p) => /^claude-/.test(p.key) && !p.resolved));

  // نسخة Claude Code قديمة ما تعرف --effort: نشيله هو بس ونبقى على الموديل الخفيف
  {
    const fake = path.join(process.env.RASID_DATA, 'oldclaude.sh');
    fs.writeFileSync(
      fake,
      [
        '#!/bin/sh',
        'echo "$*" >> "$(dirname "$0")/args.log"',
        'case "$*" in *--effort*) echo "error: unknown option \'--effort\'" >&2; exit 1;; esac',
        'cat >/dev/null',
        'echo \'{"type":"result","is_error":false,"result":"{\\"ok\\":true}"}\'',
      ].join('\n') + '\n',
      { mode: 0o755 }
    );
    const oldPath = d.config.claudePath;
    d.config.claudePath = fake;
    delete process.env.RASID_MOCK;
    const res = await ai.askJson('x', { model: 'haiku', effort: 'low' });
    const calls = fs.readFileSync(path.join(process.env.RASID_DATA, 'args.log'), 'utf8').trim().split('\n');
    ok('an older Claude Code without --effort: only that flag is dropped, still on the light model', res.ok === true && calls.length === 2 && calls[1].includes('--model haiku') && !calls[1].includes('--effort') && ai.getLevel() === 0 && ai.unsupported.has('--effort'));
    ai.unsupported.clear();
    process.env.RASID_MOCK = '1';
    d.config.claudePath = oldPath;
  }

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
  pipeline.status.frozen = true;
  resp = await fetch(base + '/api/run/search', { method: 'POST', headers: { 'X-Rasid': '1' }, body: '{}' });
  ok('while updating, new searches are refused politely', resp.status === 409 && /يتحدّث/.test((await resp.json()).error));
  pipeline.unfreeze();

  // حسابات منفصلة: «أضف حساب»
  {
    const H = (acct) => ({ 'X-Rasid': '1', 'X-Rasid-Account': acct });
    resp = await fetch(base + '/api/accounts/add', { method: 'POST', headers: { 'X-Rasid': '1' }, body: JSON.stringify({ label: 'Second' }) });
    const acct = (await resp.json()).id;
    let s2 = await (await fetch(base + '/api/state?a=' + acct)).json();
    ok('add account: a fresh, separate account that starts at the setup wizard', /^[a-f0-9]{12}$/.test(acct) && s2.account === acct && !s2.config.setupDone && s2.jobs.length === 0 && s2.accounts.length === 2 && s2.accounts[1].name === 'Second');
    await fetch(base + '/api/config', { method: 'POST', headers: H(acct), body: JSON.stringify({ gmail: { user: 'second@gmail.com' }, profile: { name: 'Second Person' }, dailyCap: 5 }) });
    const cvRes = await fetch(base + '/api/cv', { method: 'POST', headers: { ...H(acct), 'X-Filename': 'second.pdf' }, body: Buffer.alloc(1200, 2) });
    s2 = await (await fetch(base + '/api/state?a=' + acct)).json();
    const s1 = await (await fetch(base + '/api/state')).json();
    ok('each account keeps its own Gmail, profile, settings and CV', cvRes.status === 200 && s2.config.gmail.user === 'second@gmail.com' && s2.config.dailyCap === 5 && s2.config.cv.originalName === 'second.pdf' && s1.config.gmail.user === 'me@gmail.com' && s1.config.profile.name === 'Test User' && s1.config.cv.originalName === 'Test_CV.pdf' && s1.jobs.length === d.jobs.length && fs.existsSync(path.join(tmp, 'accounts', acct, 'cv.pdf')) && store.within(acct, () => mailer.cvPath(store.load().config)) === path.join(tmp, 'accounts', acct, 'cv.pdf'));
    store.saveNow();
    ok('on disk: the second account lives in its own folder; the main data file never mentions it', JSON.parse(fs.readFileSync(path.join(tmp, 'accounts', acct, 'rasid.json'), 'utf8')).config.profile.name === 'Second Person' && !fs.readFileSync(path.join(tmp, 'rasid.json'), 'utf8').includes('Second Person'));
    const t2 = JSON.parse(await (await fetch(base + '/api/tool/program_status', { method: 'POST', headers: H(acct), body: '{}' })).text());
    ok('chat tools act on the account that is chatting', t2.gmail_account === 'second@gmail.com');
    const mcpFile = store.within(acct, () => require('../src/chat').mcpConfigFile());
    ok("the chat's tool bridge is told which account it serves", mcpFile === path.join(tmp, 'accounts', acct, 'mcp.json') && JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers.rasid.env.RASID_ACCOUNT === acct);
    ok('an unknown account is refused', (await fetch(base + '/api/state?a=ffffffffffff')).status === 404 && (await fetch(base + '/api/state?a=../../etc')).status === 404);

    let releaseA;
    const busyA = pipeline.withMain('A', () => new Promise((res) => (releaseA = res)));
    await assert.rejects(store.within(acct, () => pipeline.cycle(true)), /مشغول/);
    const seen = await (await fetch(base + '/api/state?a=' + acct)).json();
    ok('one search at a time across accounts; the other account sees whose turn it is', seen.status.main === 'أحمد: A' && seen.status.mine === false);
    releaseA();
    await busyA;

    store.within(acct, () => ai.reportAiError(new Error("CLAUDE_ERROR: You've hit your session limit · resets 11:59pm"), 'البحث'));
    ok('one Claude subscription: a limit hit in one account pauses Claude for all', ai.paused() > 0 && store.within(acct, () => store.load().problems.some((p) => p.key === 'claude-limit' && !p.resolved)));
    ai.resume();
    ok('...and the pause clears for all', !store.within(acct, () => store.load().problems.some((p) => p.key === 'claude-limit' && !p.resolved)));

    const acct3 = store.addAccount('Third');
    fs.writeFileSync(path.join(tmp, 'accounts', acct3, 'rasid.json'), JSON.stringify({ jobs: [{ id: 'j1', title: 'T', company: 'C', status: 'ready', applyEmail: 'x@y.example', sendingAt: Date.now(), sentAt: 0, draft: { subject: 's', body: 'b' } }] }));
    const j3 = store.within(acct3, () => store.load().jobs[0]);
    ok('a send cut off by a restart is never resent by itself (left for you to check)', j3.status === 'failed' && !j3.sendingAt && /المرسل/.test(j3.lastError));
    store.removeAccount(acct3);

    resp = await fetch(base + '/api/accounts/remove', { method: 'POST', headers: H(acct), body: '{}' });
    ok('remove account: gone from the list, its folder kept aside (not deleted), main untouched', resp.status === 200 && (await fetch(base + '/api/state?a=' + acct)).status === 404 && fs.readdirSync(path.join(tmp, 'removed')).some((f) => f.startsWith(acct)) && store.accounts().length === 1 && d.jobs.length > 0);
    ok('the main account cannot be removed', (await fetch(base + '/api/accounts/remove', { method: 'POST', headers: H('main'), body: '{}' })).status === 400);
  }

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
    // التحديث إجباري: يتحقق أول، بعدين يوقف كل شي ويركّب على طول
    fs.writeFileSync(path.join(ROOT, 'README.md'), original);
    fs.writeFileSync(path.join(ROOT, 'version.json'), savedVersion);
    const hooks = [];
    const H2 = { before: async () => hooks.push('before'), after: () => hooks.push('after') };
    serveReadme = Buffer.from('tampered');
    await assert.rejects(update.auto(H2), /التوقيع/);
    ok('a broken update never stops what is running; the error is kept for the settings page', hooks.length === 0 && update.local().build === mine.build && /التوقيع/.test(d.state.updateError));
    serveReadme = newReadme;
    d.config.autoUpdate = false; // المفتاح القديم ما يمنع التحديث
    const out2 = await update.auto(H2);
    ok('updates are mandatory: verified first, then everything stops, then it installs (even with the old switch off)', out2.updated === true && hooks.join() === 'before' && update.local().build === mine.build + 1 && d.state.updateError === '');
    const [a1, a2] = await Promise.all([update.auto(H2), update.auto(H2)]);
    ok('two update checks at once never run twice', a1 === a2 || (a1.updated === false && a2.updated === false));
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
