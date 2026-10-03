'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? esc(u) : '#');

let S = null; // آخر حالة من الخادم
let view = 'brief';
let jobTab = 'wait';
let openJob = null;

async function call(path, body, opts = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'X-Rasid': '1', ...(opts.headers || {}) },
    body: opts.raw ? body : JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'صار خطأ.');
  if (data.config) S = data;
  return data;
}

function toast(text, bad) {
  const t = $('#toast');
  t.textContent = text;
  t.className = 'show' + (bad ? ' err' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = ''), bad ? 6000 : 3200);
}

async function act(btn, fn, okText) {
  if (btn) btn.disabled = true;
  try {
    await fn();
    if (okText) toast(okText);
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
    render();
  }
}

/* ---------- الوقت ---------- */
function ago(t) {
  if (!t) return 'ما صار بعد';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'الحين';
  if (m < 60) return `قبل ${m} د`;
  const h = Math.round(m / 60);
  if (h < 24) return `قبل ${h} س`;
  return `قبل ${Math.round(h / 24)} يوم`;
}
const clock = (t) => {
  const d = new Date(t);
  const same = d.toDateString() === new Date().toDateString();
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return same ? hm : `${d.getDate()}/${d.getMonth() + 1} ${hm}`;
};

/* ---------- الإعداد أول مرة ---------- */
const PF = ['name', 'nickname', 'phone', 'location', 'nationality', 'birthDate', 'linkedin', 'headline', 'summary', 'targets', 'avoid', 'noticePeriod', 'extra'];
let wzStep = 0;

function wzGo(n) {
  wzStep = n;
  $$('.wz-pane').forEach((p) => (p.hidden = Number(p.dataset.step) !== n));
  $$('#wzSteps li').forEach((li, i) => (li.className = i === n ? 'on' : i < n ? 'done' : ''));
  window.scrollTo(0, 0);
  const first = $(`.wz-pane[data-step="${n}"] input:not([type=file]):not([type=radio]), .wz-pane[data-step="${n}"] textarea`);
  if (first && !first.value) first.focus();
}
const wzMsg = (i, text, kind) => {
  const el = $('#wzMsg' + i);
  el.textContent = text || '';
  el.className = 'msg ' + (kind || '');
};

function initWizard() {
  const c = S.config;
  $('#wzUser').value = c.gmail.user || '';
  if (c.gmail.hasPassword) $('#wzPass').placeholder = 'محفوظة — اتركها فاضية لو ما تبغى تغيّرها';
  PF.forEach((k) => ($('#pf_' + k).value = c.profile[k] || ''));
  if (c.cv.originalName) markCv(c.cv.originalName);
  $$('input[name=wzMode]').forEach((r) => (r.checked = r.value === c.mode));
  $('#wzFit').value = c.minFit;
  $('#wzCap').value = c.dailyCap;
  $$('[data-back]').forEach((b) => (b.onclick = () => wzGo(wzStep - 1)));

  $('.wz-pane[data-step="0"]').onsubmit = async (e) => {
    e.preventDefault();
    const user = $('#wzUser').value.trim();
    const pass = $('#wzPass').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(user)) return wzMsg(0, 'اكتب عنوان الجيميل كامل.', 'err');
    if (!pass && !S.config.gmail.hasPassword) return wzMsg(0, 'حط كلمة مرور التطبيقات.', 'err');
    if (pass && pass.replace(/\s/g, '').length !== 16) return wzMsg(0, 'كلمة مرور التطبيقات ١٦ حرف بالضبط. هذي تبدو كلمة السر العادية — شوف «من وين أجيبها؟».', 'err');
    const btn = e.submitter;
    btn.disabled = true;
    wzMsg(0, 'أتحقق من الاتصال بجيميل…');
    try {
      await call('/api/gmail/test', { gmail: { user, appPassword: pass } });
      await refresh();
      wzGo(1);
    } catch (err) {
      wzMsg(0, err.message, 'err');
    }
    btn.disabled = false;
  };

  $('#wzCv').onchange = async () => {
    const f = $('#wzCv').files[0];
    if (!f) return;
    wzMsg(1, 'يرفع الملف…');
    try {
      await call('/api/cv', f, { raw: true, headers: { 'X-Filename': encodeURIComponent(f.name), 'Content-Type': 'application/octet-stream' } });
      markCv(f.name);
      wzMsg(1, 'انرفع الملف.', 'ok');
      await refresh();
    } catch (err) {
      wzMsg(1, err.message, 'err');
    }
  };

  $('.wz-pane[data-step="1"]').onsubmit = async (e) => {
    e.preventDefault();
    if (!S.config.cv.originalName) return wzMsg(1, 'ارفع السيرة أول — ما أقدر أقدّم بدونها.', 'err');
    const btn = e.submitter;
    if (/\.pdf$/i.test(S.config.cv.originalName) && !S.config.cv.hasText) {
      btn.disabled = true;
      wzMsg(1, 'أقرا السيرة وأعبّي معلوماتك منها… (دقيقة تقريباً)');
      try {
        const { profile } = await call('/api/cv/read');
        PF.forEach((k) => {
          if (profile[k] && !$('#pf_' + k).value) $('#pf_' + k).value = profile[k];
        });
        $('#wzLead2').textContent = 'عبّيتها من سيرتك — راجعها وعدّل اللي تبغاه. ما أكتب عنك شي مو موجود هنا أو في السيرة.';
        await refresh();
      } catch (err) {
        $('#wzLead2').textContent = 'ما قدرت أقرا السيرة تلقائياً (' + err.message + ') — عبّي الخانات يدوياً.';
      }
      btn.disabled = false;
      wzMsg(1, '');
    }
    wzGo(2);
  };

  $('.wz-pane[data-step="2"]').onsubmit = async (e) => {
    e.preventDefault();
    const profile = Object.fromEntries(PF.map((k) => [k, $('#pf_' + k).value]));
    if (!profile.name.trim()) return wzMsg(2, 'الاسم مطلوب — يظهر في توقيع الرسائل.', 'err');
    if (!profile.targets.trim()) return wzMsg(2, 'اكتب الوظائف اللي تبغاها عشان أعرف على أيش أبحث.', 'err');
    if (!profile.summary.trim() && !S.config.cv.hasText) return wzMsg(2, 'اكتب نبذة عن خبرتك — منها أكتب رسائل التقديم.', 'err');
    try {
      await call('/api/config', { profile });
      wzMsg(2, '');
      wzGo(3);
    } catch (err) {
      wzMsg(2, err.message, 'err');
    }
  };

  $('.wz-pane[data-step="3"]').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await call('/api/config', { mode: $('input[name=wzMode]:checked').value, minFit: $('#wzFit').value, dailyCap: $('#wzCap').value, setupDone: true });
      call('/api/run/search').catch(() => {});
      showApp();
    } catch (err) {
      wzMsg(3, err.message, 'err');
    }
  };

  // يكمّل من حيث وقف
  // لو السيرة مرفوعة بس ما انقرت بعد، نرجع لخطوتها عشان «كمّل» يقراها ويعبّي الخانات
  const unread = /\.pdf$/i.test(c.cv.originalName || '') && !c.cv.hasText && !c.profile.name;
  wzGo(!c.gmail.hasPassword ? 0 : !c.cv.originalName || unread ? 1 : !c.profile.name || !c.profile.targets ? 2 : 3);
}
function markCv(name) {
  $('#wzCvName').textContent = name;
  $('#wzDrop').classList.add('has');
}

/* ---------- اللوحة ---------- */
const ST = {
  new: 'جديدة — ما انكتبت رسالتها بعد',
  low: 'تطابق ضعيف',
  ready: 'جاهزة للإرسال',
  manual: 'تقديمها من موقع الشركة',
  sent: 'انرسل التقديم',
  manual_done: 'قدّمت يدوياً',
  skipped: 'متجاهلة',
  failed: 'ما وصل',
};
const applied = (j) => j.status === 'sent' || j.status === 'manual_done';
const waiting = (j) => j.status === 'ready' || j.status === 'manual';
const manual = (j) => j.status === 'manual';
let printing = false;
const needsFollowUp = (j) =>
  j.status === 'sent' && j.applyEmail && !j.repliedAt && !j.followUpSentAt && Date.now() - j.sentAt > S.config.followUpDays * 864e5;

function showApp() {
  $('#wizard').hidden = true;
  $('#app').hidden = false;
  render();
  openBrief();
}

/* ---------- الموجز الصوتي ---------- */
let voiceState = 'idle'; // loading | idle | speaking | blocked | novoice
let voiceRun = 0;

function arVoice() {
  if (!window.speechSynthesis) return null;
  const score = (v) => (/ar[-_]OM/i.test(v.lang) ? 8 : /ar[-_](AE|SA|KW|QA|BH)/i.test(v.lang) ? 4 : 0) + (/natural|online|neural/i.test(v.name) ? 2 : 0);
  return speechSynthesis.getVoices().filter((v) => /^ar/i.test(v.lang)).sort((a, b) => score(b) - score(a))[0] || null;
}
// قائمة الأصوات تتحمّل بعد فتح الصفحة بلحظة
function voicesReady() {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) return resolve();
    if (speechSynthesis.getVoices().length) return resolve();
    const done = () => resolve();
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 2500);
  });
}
function setVoice(st) {
  voiceState = st;
  render();
}
function stopSpeaking() {
  voiceRun++;
  if (window.speechSynthesis) speechSynthesis.cancel();
  setVoice('idle');
}
function markHeard() {
  if (S.brief) S.brief.heard = true;
  call('/api/brief/heard').catch(() => {});
}
async function speak(text, isBrief = true) {
  await voicesReady();
  const voice = arVoice();
  if (!voice) return setVoice('novoice');
  const run = ++voiceRun;
  speechSynthesis.cancel();
  // جملة جملة: النصوص الطويلة تنقطع في بعض المتصفحات
  const parts = (text.match(/[^.!?؟\n]+[.!?؟]*/g) || [text]).map((p) => p.trim()).filter(Boolean);
  let started = false;
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = 1.12;
    u.onstart = () => {
      started = true;
      if (run === voiceRun && voiceState !== 'speaking') setVoice('speaking');
    };
    u.onerror = (e) => {
      if (run !== voiceRun) return;
      if (e.error === 'not-allowed') waitForClick(text, isBrief);
    };
    if (i === parts.length - 1)
      u.onend = () => {
        if (run !== voiceRun) return;
        if (isBrief) markHeard();
        setVoice('idle');
      };
    speechSynthesis.speak(u);
  });
  // بعض المتصفحات تمنع الصوت قبل أول ضغطة بدون ما تبلّغ
  setTimeout(() => {
    if (run === voiceRun && !started && !speechSynthesis.speaking) waitForClick(text, isBrief);
  }, 1800);
}
function waitForClick(text, isBrief) {
  if (voiceState === 'blocked') return;
  speechSynthesis.cancel();
  setVoice('blocked');
  const go = (e) => {
    document.removeEventListener('pointerdown', go, true);
    document.removeEventListener('keydown', go, true);
    if (voiceState === 'blocked' && !(e.target.closest && e.target.closest('[data-voice]'))) speak(text, isBrief);
  };
  document.addEventListener('pointerdown', go, true);
  document.addEventListener('keydown', go, true);
}
async function openBrief(force) {
  if (S.config.voice === false && !force) return;
  setVoice('loading');
  try {
    const { brief } = await call(force ? '/api/brief/refresh' : '/api/brief/open');
    S.brief = brief;
  } catch (e) {
    return setVoice('idle');
  }
  setVoice('idle');
  if (S.brief && (!S.brief.heard || force)) speak(S.brief.text);
}
function voicePanel() {
  if (S.config.voice === false) return '';
  if (voiceState === 'loading') return '<section class="voice"><p class="who">راصد</p><p class="script">أجهّز لك موجز الجديد…</p></section>';
  const b = S.brief;
  if (!b) return '';
  if (b.heard && voiceState !== 'speaking') return '';
  const hint = { blocked: 'المتصفح ما يشغّل الصوت إلا بعد أول ضغطة — اضغط أي مكان وأبدأ أكلمك.', novoice: 'ما في صوت عربي في هالمتصفح. افتح راصد في Microsoft Edge عشان أكلمك بالصوت — والنص قدامك تقراه.' }[voiceState];
  return `<section class="voice ${voiceState}" aria-live="polite">
    <p class="who">${voiceState === 'speaking' ? 'راصد يكلمك' : 'موجز راصد'}</p>
    <p class="script">${esc(b.text)}</p>
    <div class="acts">
      ${voiceState === 'speaking' ? '<button class="btn" data-voice="stop">وقّف</button>' : voiceState === 'novoice' ? '' : '<button class="btn primary" data-voice="play">اسمع الموجز</button>'}
      ${voiceState === 'speaking' ? '' : '<button class="btn" data-voice="done">تمام، قريته</button>'}
    </div>
    ${hint ? `<p class="hint">${hint}</p>` : ''}
  </section>`;
}

function render(railOnly) {
  if (!S || $('#app').hidden) return;
  const unseen = S.messages.filter((m) => !m.seen).length;
  $('#cJobs').textContent = S.jobs.filter(waiting).length || '';
  $('#cReplies').textContent = unseen || '';
  $('#cProblems').textContent = S.problems.length || '';
  const live = $('#live');
  live.className = 'live' + (S.status.main ? ' busy' : '');
  live.textContent = S.status.main || `آخر بحث ${ago(S.state.lastSearch)} · آخر فحص للردود ${ago(S.state.lastInbox)}`;
  $('#runSearch').disabled = !!S.status.main;
  $$('.rail>button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  if (railOnly) return;
  // ما نعيد الرسم وأنت تكتب
  const a = document.activeElement;
  if (a && $('#main').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return;
  $('#main').innerHTML = { brief, chat: chatView, jobs, replies, news, problems, settings }[view]();
  if (view === 'chat') { const log = $('#chatLog'); log.scrollTop = log.scrollHeight; }
}

function sentence() {
  const done = S.jobs.filter(applied).length;
  const wait = S.jobs.filter(waiting).length;
  const unseen = S.messages.filter((m) => !m.seen).length;
  const parts = [];
  if (!S.jobs.length) return S.status.main ? 'أبحث لك عن أول دفعة وظائف. <em>تاخذ بضع دقائق.</em>' : 'ما في وظائف بعد. <em>اضغط «ابحث الحين».</em>';
  parts.push(done ? `قدّمت على <em>${done}</em> ${done > 10 ? 'وظيفة' : done > 2 ? 'وظائف' : done === 2 ? 'وظيفتين' : 'وظيفة'}` : 'ما قدّمت على شي بعد');
  if (unseen) parts.push(`وصلك <em>${unseen === 1 ? 'رد جديد' : unseen + ' ردود جديدة'}</em>`);
  if (wait) parts.push(`و<em>${wait}</em> تنتظرك`);
  if (S.problems.length) parts.push(`وفيه <em>${S.problems.length === 1 ? 'مشكلة' : S.problems.length + ' مشاكل'}</em> تحتاج انتباهك`);
  return parts.join('، ') + '.';
}

function brief() {
  const need = [];
  S.problems.forEach((p) => need.push(`<li class="bad"><p>${esc(p.text)}<small>${esc(p.fix)}</small></p><button class="btn ghost sm" data-go="problems">التفاصيل</button></li>`));
  S.messages
    .filter((m) => !m.seen && ['interview', 'offer', 'info_request'].includes(m.category))
    .forEach((m) => need.push(`<li class="good"><p>${esc(m.label)} من ${esc(m.fromName || m.from)}<small>${esc(m.action || m.summary)}</small></p><button class="btn ghost sm" data-go="replies">افتح</button></li>`));
  const ready = S.jobs.filter((j) => j.status === 'ready');
  if (ready.length && S.config.mode !== 'auto') need.push(`<li><p>${ready.length} رسالة تقديم جاهزة تنتظر موافقتك<small>راجعها واضغط «أرسل».</small></p><button class="btn primary sm" data-go="jobs" data-tab="wait">راجعها</button></li>`);
  const man = S.jobs.filter(manual);
  if (man.length) need.push(`<li><p>${man.length} شركة ما قدرت أرسل لها إيميل — لازم تقدّم أنت من موقعها<small>${esc(man.slice(0, 3).map((j) => j.company).join('، '))}${man.length > 3 ? ' وغيرها' : ''}. جهّزت لك الرابط والخطوات وبياناتك للنسخ.</small></p><button class="btn primary sm" data-go="jobs" data-tab="manual">افتح القائمة</button></li>`);
  const fu = S.jobs.filter(needsFollowUp);
  if (fu.length) need.push(`<li><p>${fu.length} تقديم مرّ عليه ${S.config.followUpDays} أيام بدون رد<small>تبغى أكتب لهم متابعة؟</small></p><button class="btn ghost sm" data-go="jobs" data-tab="done">شوفها</button></li>`);

  const replay = S.config.voice !== false && S.brief && S.brief.heard && voiceState !== 'speaking' && voiceState !== 'loading'
    ? ' · <button class="replay" data-voice="play">اسمع الموجز مرة ثانية</button> · <button class="replay" data-voice="fresh">موجز جديد</button>' : '';
  const upd = S.update ? `<section class="update"><p>في تحديث جديد للبرنامج (نسخة ${S.update.build})<small>${esc(S.update.notes)}</small></p><button class="btn primary" id="doUpdate">حدّث الحين</button></section>` : '';
  return `
    ${upd}
    ${voicePanel()}
    <h1 class="say">${sentence()}</h1>
    <p class="sub">${S.config.mode === 'auto' ? 'الإرسال التلقائي شغّال' : 'ما ينرسل شي إلا بموافقتك'} · انرسل اليوم ${S.sentToday} من ${S.config.dailyCap} · يبحث كل ${S.config.searchEveryHours} ساعة ويفحص الردود كل ${S.config.inboxEveryMinutes} دقيقة${replay}</p>
    <h2>يحتاجك</h2>
    ${need.length ? `<ul class="need">${need.join('')}</ul>` : '<p class="empty">ما في شي ينتظرك الحين.</p>'}
    <h2>ايش صار <span>الأحدث فوق</span></h2>
    ${S.events.length ? `<ol class="log">${S.events.slice(0, 40).map((e) => `<li class="${e.level}"><time>${clock(e.t)}</time><p>${esc(e.text)}</p></li>`).join('')}</ol>` : '<p class="empty">السجل فاضي.</p>'}`;
}

/* ---------- كلّم راصد ---------- */
let chatBusy = false;
let chatPending = '';
let chatDraft = '';
let listening = null;
const Recog = window.SpeechRecognition || window.webkitSpeechRecognition;
const TRIES = ['شيّك على الإيميل', 'ايش آخر شي قدّمت عليه؟', 'اقرا عن شركة (اكتب اسمها) وقل لي رأيك', 'ضيف هذا الإيميل وقدّم عليه: '];

function chatView() {
  const msgs = S.chat || [];
  const bubble = (m) => `<div class="${m.who}"><p>${esc(m.text)}</p>${m.done && m.done.length ? `<ul>${m.done.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
  return `<h1 class="page-h">كلّم راصد</h1>
  <div class="chat" id="chatLog">
    ${msgs.length || chatBusy ? msgs.map(bubble).join('') : `<div class="rasid"><p>أنا هنا. قل لي ايش تبغى: أعدّل رسالة، أضيف شركة، أشيّك على الإيميل، أو أقرا لك عن شركة وأعطيك رأيي.</p></div>`}
    ${chatBusy ? `<div class="me"><p>${esc(chatPending)}</p></div><div class="rasid thinking"><p>أشتغل على طلبك… <span id="chatTimer"></span></p></div>` : ''}
  </div>
  ${msgs.length ? '' : `<div class="tries">${TRIES.map((t) => `<button data-try="${esc(t)}">${esc(t)}</button>`).join('')}</div>`}
  <form class="chat-in" id="chatForm">
    <textarea id="chatText" rows="2" dir="auto" placeholder="اكتب لراصد…" ${chatBusy ? 'disabled' : ''}>${esc(chatDraft)}</textarea>
    ${Recog ? `<button type="button" class="btn ghost ${listening ? 'listening' : ''}" id="mic" ${chatBusy ? 'disabled' : ''}>${listening ? 'أسمعك…' : 'تكلّم'}</button>` : ''}
    <button class="btn primary" ${chatBusy ? 'disabled' : ''}>أرسل</button>
  </form>`;
}

async function sendChat(text, spoken) {
  text = text.trim();
  if (!text || chatBusy) return;
  chatBusy = true;
  chatPending = text;
  const t0 = Date.now();
  // الرد يظهر كلمة كلمة وهو ينكتب
  const tick = setInterval(async () => {
    const box = $('.chat .thinking p');
    if (!box) return;
    try {
      const live = await (await fetch('/api/chat/live')).json();
      const sec = Math.round((Date.now() - t0) / 1000);
      if (live.text) box.textContent = live.text;
      else box.textContent = `أشتغل على طلبك… (${sec} ث)`;
      const log = $('#chatLog');
      log.scrollTop = log.scrollHeight;
    } catch (_) {}
  }, 350);
  chatDraft = '';
  if (document.activeElement) document.activeElement.blur();
  render();
  try {
    const out = await call('/api/chat', { text });
    S = out.state;
    if (spoken && S.config.voice !== false) speak(out.reply, false);
  } catch (e) {
    toast(e.message, true);
    chatDraft = text;
  }
  clearInterval(tick);
  chatBusy = false;
  render();
  const box = $('#chatText');
  if (box && view === 'chat') box.focus();
}

function toggleMic() {
  if (listening) return listening.stop();
  const r = new Recog();
  r.lang = 'ar-OM';
  r.interimResults = false;
  r.onresult = (e) => sendChat(e.results[0][0].transcript, true);
  r.onerror = (e) => toast(e.error === 'not-allowed' ? 'اسمح للمتصفح يستخدم المايك.' : 'ما سمعتك زين، جرّب مرة ثانية أو اكتب.', true);
  r.onend = () => { listening = null; render(); };
  listening = r;
  if (window.speechSynthesis) speechSynthesis.cancel();
  r.start();
  render();
}

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'chatForm') return;
  e.preventDefault();
  sendChat($('#chatText').value);
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'chatText') chatDraft = e.target.value;
});
document.addEventListener('keydown', (e) => {
  if (e.target.id === 'chatText' && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat(e.target.value);
  }
});

const TABS = {
  wait: ['جاهزة للإرسال', (j) => j.status === 'ready'],
  manual: ['قدّم عليها بنفسك', manual],
  done: ['قدّمت عليها', applied],
  not: ['ما قدّمت عليها', (j) => !waiting(j) && !applied(j)],
  all: ['الكل', () => true],
};

function jobs() {
  const list = S.jobs.filter(TABS[jobTab][1]).sort((a, b) => (applied(a) ? b.sentAt - a.sentAt : b.fit - a.fit));
  return `
    <h1 class="page-h">الوظائف</h1>
    <div class="tabs">${Object.entries(TABS).map(([k, [label, f]]) => `<button data-tab="${k}" class="${k === jobTab ? 'on' : ''}">${label} (${S.jobs.filter(f).length})</button>`).join('')}</div>
    ${jobTab === 'manual' && list.length ? `<p class="lead" style="margin-bottom:1rem">هذي ما لها إيميل تقديم، فما قدرت أرسل لها. كل وحدة فيها الرابط، الخطوات، وبياناتك جاهزة للنسخ. بعد ما تقدّم اضغط «قدّمت عليها».</p><div class="acts" style="margin-bottom:1rem"><button class="btn ghost sm" id="printManual">اطبع القائمة</button></div>` : ''}
    ${list.length ? list.map(jobRow).join('') : `<p class="empty">${jobTab === 'wait' ? 'ما في شي جاهز للإرسال.' : jobTab === 'manual' ? 'ما في شي تقدّم عليه بنفسك.' : 'ما في وظائف هنا.'}</p>`}`;
}

function jobRow(j) {
  const open = openJob === j.id || (printing && j.status === 'manual');
  const reply = j.replyCategory && j.replyCategory !== 'bounce' ? `<span class="tag reply">${esc({ interview: 'مقابلة', offer: 'عرض', rejection: 'اعتذار', info_request: 'يطلبون شي', auto_reply: 'رد تلقائي', other: 'رد' }[j.replyCategory])}</span>` : '';
  const fu = needsFollowUp(j) ? '<span class="tag ready">تحتاج متابعة</span>' : '';
  return `<div class="job">
    <button class="job-row" data-open="${j.id}" aria-expanded="${open}">
      <span class="fit ${j.fit < S.config.minFit ? 'low' : ''}" title="نسبة التطابق">${j.fit}<i style="--w:${j.fit}%"></i></span>
      <span><span class="job-t">${esc(j.title)}</span><br><span class="job-c">${esc(j.company)}${j.location ? ' — ' + esc(j.location) : ''}${j.deadline ? ' — آخر موعد ' + esc(j.deadline) : ''}</span></span>
      <span><span class="tag ${j.status}">${ST[j.status]}</span>${reply}${fu}</span>
    </button>
    ${open ? jobBody(j) : ''}
  </div>`;
}

function age(b) {
  const m = String(b || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return '';
  const now = new Date();
  let a = now.getFullYear() - Number(m[1]);
  if (now.getMonth() + 1 < Number(m[2]) || (now.getMonth() + 1 === Number(m[2]) && now.getDate() < Number(m[3]))) a--;
  return a > 0 && a < 100 ? String(a) : '';
}
function guide(j) {
  const p = S.config.profile;
  const steps = j.applySteps
    ? j.applySteps.split(/\n|(?:^|\s)(?:\d+|[١-٩])[.)\-]\s*/).map((x) => x.replace(/^\s*(?:\d+|[١-٩])[.)\-]\s*/, '').trim()).filter((x) => x.length > 3)
    : ['افتح صفحة التقديم من الزر تحت.', 'اضغط Apply / تقديم. لو طلب حساب، سجّل بإيميلك اللي تحت.', 'عبّي الخانات من جدول بياناتك (انسخ والصق).', 'ارفع ملف السيرة، والصق نص الرسالة لو فيه خانة Cover Letter.'];
  steps.push('لما تخلص، ارجع هنا واضغط «قدّمت عليها».');
  const rows = [
    ['اسم الوظيفة', j.title.replace(/^Speculative application – /, '')],
    ['الاسم الكامل', p.name],
    ['الإيميل', S.config.gmail.user],
    ['الهاتف', p.phone],
    ['الجنسية', p.nationality],
    ['تاريخ الميلاد', p.birthDate],
    ['العمر', age(p.birthDate)],
    ['المدينة', p.location],
    ['المسمى / المؤهل', p.headline],
    ['متى تقدر تبدأ', p.noticePeriod],
    ['لينكدإن', p.linkedin],
    ['ملف السيرة', S.config.cv.originalName],
  ].filter((r) => r[1]);
  return `<div class="guide">
    <h3>ما لها إيميل تقديم — قدّم أنت من موقعهم</h3>
    <ol>${steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
    <table class="sheet">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td><td><button class="copy" data-copytext="${esc(v)}">انسخ</button></td></tr>`).join('')}</table>
  </div>`;
}

function jobBody(j) {
  const d = j.draft;
  const editable = d && !j.sentAt;
  const acts = [];
  if (j.status === 'ready') acts.push(`<button class="btn primary" data-act="send" data-id="${j.id}">أرسل التقديم</button>`);
  if (j.status === 'failed' && j.applyEmail && d && !j.sentAt) acts.push(`<button class="btn primary" data-act="send" data-id="${j.id}">حاول ترسل مرة ثانية</button>`);
  if (j.status === 'manual' || (j.status === 'failed' && j.url)) acts.push(`<a class="btn primary" href="${safeUrl(j.url)}" target="_blank" rel="noopener">افتح صفحة التقديم</a><button class="btn ghost" data-act="done" data-id="${j.id}">قدّمت عليها</button>`);
  if (d && j.status === 'manual') acts.push(`<button class="btn ghost" data-copy="${j.id}">انسخ النص</button>`);
  if (!d && !applied(j)) acts.push(`<button class="btn primary" data-act="draft" data-id="${j.id}">اكتب لي رسالة التقديم</button>`);
  if (editable) acts.push(`<button class="btn ghost" data-save="${j.id}">احفظ التعديل</button><button class="btn ghost" data-act="draft" data-id="${j.id}">أعد الكتابة</button>`);
  if (j.status === 'skipped') acts.push(`<button class="btn ghost" data-act="restore" data-id="${j.id}">رجّعها</button>`);
  else if (!applied(j)) acts.push(`<button class="btn ghost" data-act="skip" data-id="${j.id}">تجاهلها</button>`);
  if (j.status === 'sent' && j.applyEmail && !j.followUpSentAt) {
    acts.push(j.followUp ? `<button class="btn primary" data-fu-send="${j.id}">أرسل المتابعة</button>` : `<button class="btn ghost" data-act="followup" data-id="${j.id}">اكتب متابعة</button>`);
  }
  return `<div class="job-body">
    ${j.lastError ? `<p class="err">${esc(j.lastError)}</p>` : ''}
    ${j.status === 'manual' ? guide(j) : ''}
    ${j.verified === false ? '<p class="err">ما انفتح الإعلان وقت البحث — افتح الرابط وتأكد إن الوظيفة لسه مفتوحة قبل ما تقدّم.</p>' : ''}
    ${j.why ? `<p><span class="k">ليش تناسبك:</span> ${esc(j.why)}</p>` : ''}
    ${j.companyAbout ? `<p><span class="k">عن الشركة:</span> ${esc(j.companyAbout)}</p>` : ''}
    ${j.concerns ? `<p><span class="k">انتبه:</span> ${esc(j.concerns)}</p>` : ''}
    ${j.requirements ? `<p dir="auto"><span class="k">المطلوب:</span> ${esc(j.requirements)}</p>` : ''}
    <p><span class="k">المصدر:</span> <a href="${safeUrl(j.url)}" target="_blank" rel="noopener">${esc(j.source || 'الإعلان')}</a>
      ${j.sentAt ? ` · <span class="k">${j.status === 'manual_done' ? 'قدّمت' : 'انرسل'} ${ago(j.sentAt)}${j.applyEmail && j.status === 'sent' ? ' إلى ' + esc(j.applyEmail) : ''}</span>` : ''}
      ${j.followUpSentAt ? ` · <span class="k">متابعة انرسلت ${ago(j.followUpSentAt)}</span>` : ''}</p>
    ${d ? `<div class="letter">
      ${editable ? `<label>يروح إلى <input dir="ltr" id="em_${j.id}" value="${esc(j.applyEmail)}" placeholder="ما في إيميل — التقديم من الموقع"></label>` : ''}
      <label>العنوان <input dir="auto" id="su_${j.id}" value="${esc(d.subject)}" ${editable ? '' : 'readonly'}></label>
      <label>نص الرسالة <textarea dir="auto" id="bo_${j.id}" rows="11" ${editable ? '' : 'readonly'}>${esc(d.body)}</textarea></label>
    </div>` : ''}
    ${j.followUp && !j.followUpSentAt ? `<div class="letter"><label>نص المتابعة <textarea dir="auto" rows="5" readonly>${esc(j.followUp.body)}</textarea></label></div>` : ''}
    <div class="acts">${acts.join('')}</div>
  </div>`;
}

function replies() {
  const jobOf = (m) => S.jobs.find((j) => j.id === m.jobId);
  return `<h1 class="page-h">الردود</h1>
  ${S.messages.length ? S.messages.map((m) => {
    const j = jobOf(m);
    return `<article class="card ${m.category}" data-msg="${m.id}">
      <h3>${m.seen ? '' : '<span class="unseen" title="جديد"></span>'}${esc(m.label)} — ${esc(m.fromName || m.from)}</h3>
      <p class="meta">${j ? `بخصوص ${esc(j.title)} في ${esc(j.company)} · ` : ''}${clock(m.date)} · <span dir="ltr">${esc(m.from)}</span></p>
      ${m.summary ? `<p>${esc(m.summary)}</p>` : ''}
      ${m.action ? `<p class="do">المطلوب منك: ${esc(m.action)}</p>` : ''}
      <details><summary>نص الرسالة</summary><p><strong>${esc(m.subject)}</strong><br>${esc(m.snippet)}</p></details>
    </article>`;
  }).join('') : `<p class="empty">ما وصل رد بعد. آخر فحص ${ago(S.state.lastInbox)}.</p>`}`;
}

function news() {
  return `<h1 class="page-h">أخبار تهم بحثك</h1>
  <div class="acts" style="margin-bottom:1.2rem"><button class="btn ghost sm" id="runNews" ${S.status.main ? 'disabled' : ''}>حدّث الأخبار</button></div>
  ${S.news.length ? S.news.map((n) => `<article class="card">
      <h3><a href="${safeUrl(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a></h3>
      <p class="meta">${esc(n.source)}${n.date ? ' · ' + esc(n.date) : ''}</p>
      <p>${esc(n.summary)}</p>${n.why ? `<p class="do">${esc(n.why)}</p>` : ''}
    </article>`).join('') : `<p class="empty">ما في أخبار بعد. آخر تحديث ${ago(S.state.lastNews)}.</p>`}`;
}

function problems() {
  return `<h1 class="page-h">المشاكل</h1>
  ${S.problems.length ? `<ul class="need">${S.problems.map((p) => `<li class="bad"><p>${esc(p.text)}<small>${esc(p.fix)} · ${ago(p.t)}</small>${p.detail ? `<small dir="ltr" style="text-align:start;font-family:monospace">${esc(p.detail)}</small>` : ''}</p>${/^claude-/.test(p.key) ? '<button class="btn primary sm" id="claudeTest">جرّب Claude الحين</button>' : `<button class="btn ghost sm" data-resolve="${p.id}">انحلّت</button>`}</li>`).join('')}</ul>` : '<p class="empty">ما في مشاكل. كل شي ماشي.</p>'}
  <h2>بلّغ عن غلط في البرنامج</h2>
  <p class="lead">اضغط الزر والصق التقرير في محادثتك مع Claude واكتب ايش الغلط. فيه رقم النسخة وآخر الأخطاء، وما فيه كلمة المرور ولا محتوى رسائلك.</p>
  <div class="acts"><button class="btn ghost" id="copyReport">انسخ تقرير المشكلة</button></div>`;
}

function settings() {
  const c = S.config;
  const p = c.profile;
  const f = (k, label, tag = 'input', extra = '') => `<label class="${tag === 'textarea' || extra.includes('wide') ? 'wide' : ''}">${label}${tag === 'textarea' ? `<textarea id="s_${k}" rows="3" dir="auto">${esc(p[k])}</textarea>` : `<input id="s_${k}" dir="auto" value="${esc(p[k])}">`}</label>`;
  return `<h1 class="page-h">الإعدادات</h1><div class="set">
  <h2>طريقة الشغل</h2>
  <label>الإرسال<select id="s_mode"><option value="auto" ${c.mode === 'auto' ? 'selected' : ''}>صلاحية كاملة — أرسل تلقائياً</option><option value="review" ${c.mode === 'review' ? 'selected' : ''}>أجهّز وأنت توافق</option></select></label>
  <label class="check"><input type="checkbox" id="s_voice" ${c.voice !== false ? 'checked' : ''}> كلّمني بالصوت أول ما أفتح البرنامج</label>
  <h2>تنبيه على الجوال</h2>
  <p class="lead">يرسل لك «ايش الجديد» على الإيميل، ويوصلك تنبيه من تطبيق الإيميل في جوالك. ما يرسل شي لو ما في جديد.</p>
  <div class="grid2">
    <label>أرسل الملخص كل<select id="s_digest">${[[0, 'لا ترسل'], [6, '٦ ساعات'], [12, '١٢ ساعة'], [24, '٢٤ ساعة']].map(([v, l]) => `<option value="${v}" ${Number(c.digestEveryHours) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>على إيميل <small>فاضي = نفس الجيميل</small><input id="s_notify" dir="ltr" value="${esc(c.notifyEmail || '')}" placeholder="${esc(c.gmail.user)}"></label>
  </div>
  <div class="acts" style="margin-bottom:1.4rem"><button class="btn ghost sm" id="digestTest">جرّب: أرسل لي ملخص الحين</button></div>
  <div class="grid2">
    <label>أقل نسبة تطابق<input type="number" id="s_minFit" value="${c.minFit}" dir="ltr"></label>
    <label>أقصى تقديمات في اليوم<input type="number" id="s_dailyCap" value="${c.dailyCap}" dir="ltr"></label>
    <label>يبحث كل (ساعة)<input type="number" id="s_searchEveryHours" value="${c.searchEveryHours}" dir="ltr"></label>
    <label>يفحص الردود كل (دقيقة)<input type="number" id="s_inboxEveryMinutes" value="${c.inboxEveryMinutes}" dir="ltr"></label>
    <label>يذكّرك بالمتابعة بعد (يوم)<input type="number" id="s_followUpDays" value="${c.followUpDays}" dir="ltr"></label>
    <label>لغة الرسائل<select id="s_lang"><option value="auto" ${c.letterLanguage === 'auto' ? 'selected' : ''}>حسب لغة الإعلان</option><option value="en" ${c.letterLanguage === 'en' ? 'selected' : ''}>إنجليزي دايماً</option><option value="ar" ${c.letterLanguage === 'ar' ? 'selected' : ''}>عربي دايماً</option></select></label>
  </div>
  <h2>تحديث البرنامج</h2>
  <p class="lead">النسخة الحالية ${S.version}. يشيّك على التحديثات لحاله كل ساعة، ولما يلقى تحديث يطلع لك زر «حدّث الحين» في الموجز.</p>
  <label>مصدر التحديث<input id="s_updateRepo" dir="ltr" placeholder="ahmedalimujaini-cell/rasid" value="${esc(c.updateRepo || '')}"></label>
  <div class="acts" style="margin-bottom:1.4rem"><button class="btn ghost sm" id="checkUpdate">شيّك على تحديث الحين</button></div>
  <h2>الجيميل</h2>
  <label>العنوان<input id="s_user" dir="ltr" value="${esc(c.gmail.user)}"></label>
  <label>كلمة مرور التطبيقات <small>اتركها فاضية لو ما تبغى تغيّرها</small><input id="s_pass" type="password" dir="ltr" placeholder="${c.gmail.hasPassword ? 'محفوظة' : ''}" autocomplete="off"></label>
  <h2>السيرة الذاتية</h2>
  <div class="row"><span>${c.cv.originalName ? esc(c.cv.originalName) : 'ما في ملف مرفوع'}</span><label class="btn ghost sm" style="margin:0">غيّر الملف<input type="file" id="s_cv" accept=".pdf,.doc,.docx" hidden></label></div>
  <h2>معلوماتك</h2>
  <div class="grid2">${f('name', 'الاسم')}${f('nickname', 'ايش أناديك؟')}${f('phone', 'الهاتف')}${f('location', 'المدينة')}${f('nationality', 'الجنسية')}${f('birthDate', 'تاريخ الميلاد (مثال 2003-05-21)')}${f('linkedin', 'لينكدإن', 'input', 'wide')}${f('headline', 'المسمى المهني', 'input', 'wide')}${f('summary', 'نبذة عن خبرتك', 'textarea')}${f('targets', 'الوظائف اللي تبغاها', 'textarea')}${f('avoid', 'اللي ما تبغاه', 'textarea')}${f('noticePeriod', 'فترة الإشعار')}${f('extra', 'ملاحظات')}</div>
  <div class="acts"><button class="btn primary" id="saveSet">احفظ الإعدادات</button></div>
  </div>`;
}

/* ---------- الأحداث ---------- */
document.addEventListener('click', (e) => {
  const t = e.target.closest('button, [data-go]');
  if (!t || $('#app').hidden) return;
  const ds = t.dataset;
  if (ds.voice) {
    if (ds.voice === 'stop') return stopSpeaking();
    if (ds.voice === 'done') return markHeard(), stopSpeaking();
    if (ds.voice === 'fresh') return openBrief(true);
    return speak(S.brief.text);
  }
  if (t.id === 'mic') return toggleMic();
  if (ds.try) {
    chatDraft = ds.try;
    render();
    const box = $('#chatText');
    box.focus();
    return box.setSelectionRange(box.value.length, box.value.length);
  }
  if (t.closest('#chatForm')) return; // زر الإرسال يمر عبر submit
  if (ds.view || ds.go) {
    view = ds.view || ds.go;
    if (ds.tab) jobTab = ds.tab;
    if (view === 'replies') S.messages.filter((m) => !m.seen).forEach((m) => call(`/api/messages/${m.id}/seen`).catch(() => {}));
    document.activeElement.blur();
    render();
    if (view === 'replies') S.messages.forEach((m) => (m.seen = true));
    return;
  }
  if (ds.tab && !ds.go) return (jobTab = ds.tab), (openJob = null), render();
  if (ds.open) return (openJob = openJob === ds.open ? null : ds.open), document.activeElement.blur(), render();
  if (t.id === 'runSearch') return act(t, () => call('/api/run/search').then(refresh), 'بدأ البحث. تاخذ الدورة عادة ١٠–٣٠ دقيقة.');
  if (t.id === 'runNews') return act(t, () => call('/api/run/news').then(refresh), 'يجمع الأخبار…');
  if (t.id === 'runInbox') return act(t, async () => toast((await call('/api/run/inbox')).fresh ? 'وصلت ردود جديدة.' : 'ما في ردود جديدة.'));
  if (ds.copytext !== undefined) return navigator.clipboard.writeText(ds.copytext).then(() => toast('انسخ.'), () => toast('ما قدرت أنسخ.', true));
  if (t.id === 'printManual') {
    printing = true;
    render();
    window.print();
    printing = false;
    return render();
  }
  if (t.id === 'digestTest') return toast('أرسل…'), act(t, () => call('/api/digest/test'), 'انرسل. شوف إيميلك في الجوال.');
  if (t.id === 'checkUpdate') return act(t, async () => { await call('/api/update/check'); toast(S.update ? 'في تحديث جديد — تلقاه في الموجز.' : 'أنت على آخر نسخة.'); });
  if (t.id === 'doUpdate') return runUpdate(t);
  if (t.id === 'copyReport') {
    const errs = S.events.filter((e) => e.level === 'error').slice(0, 15).map((e) => `- ${new Date(e.t).toISOString().slice(0, 16)} ${e.text}`);
    const report = [`Rasid build ${S.version}`, navigator.userAgent, `mode=${S.config.mode} jobs=${S.jobs.length} sent=${S.jobs.filter(applied).length}`, '', 'Problems:', ...S.problems.map((p) => `- ${p.text} | ${p.detail || ''}`), '', 'Recent errors:', ...errs].join('\n');
    return navigator.clipboard.writeText(report).then(() => toast('انسخ التقرير. الصقه في محادثتك مع Claude.'), () => toast('ما قدرت أنسخ.', true));
  }
  if (t.id === 'claudeTest') return toast('أجرّب Claude…'), act(t, () => call('/api/claude/test'), 'Claude يشتغل تمام. اضغط «ابحث الحين».');
  if (ds.resolve) return act(t, () => call(`/api/problems/${ds.resolve}/resolve`));
  if (ds.copy) {
    const j = S.jobs.find((x) => x.id === ds.copy);
    return navigator.clipboard.writeText($('#bo_' + j.id).value).then(() => toast('انسخ النص.'), () => toast('ما قدرت أنسخ — حدده وانسخه يدوياً.', true));
  }
  const saveDraft = (id) => call(`/api/jobs/${id}/edit`, { applyEmail: $('#em_' + id)?.value, subject: $('#su_' + id)?.value, body: $('#bo_' + id)?.value });
  if (ds.save) return act(t, () => saveDraft(ds.save), 'انحفظ التعديل.');
  if (ds.fuSend) return act(t, () => call(`/api/jobs/${ds.fuSend}/followup`, { send: true }), 'انرسلت المتابعة.');
  if (ds.act) {
    const id = ds.id;
    const j = S.jobs.find((x) => x.id === id);
    if (ds.act === 'send') {
      if (!confirm(`أرسل التقديم على «${j.title}» إلى ${$('#em_' + id)?.value || j.applyEmail} من ${S.config.gmail.user}؟`)) return;
      return act(t, async () => { await saveDraft(id); await call(`/api/jobs/${id}/send`); }, 'انرسل التقديم.');
    }
    if (ds.act === 'draft' || ds.act === 'followup') toast('يكتب… دقيقة تقريباً.');
    return act(t, () => call(`/api/jobs/${id}/${ds.act}`), { skip: 'تجاهلتها.', done: 'سجّلتها.', draft: 'الرسالة جاهزة.', followup: 'المتابعة جاهزة — راجعها وأرسلها.' }[ds.act]);
  }
  if (t.id === 'saveSet') {
    const v = (id) => $('#' + id).value;
    const body = {
      mode: v('s_mode'), voice: $('#s_voice').checked, digestEveryHours: v('s_digest'), notifyEmail: v('s_notify'), updateRepo: v('s_updateRepo'), letterLanguage: v('s_lang'), minFit: v('s_minFit'), dailyCap: v('s_dailyCap'),
      searchEveryHours: v('s_searchEveryHours'), inboxEveryMinutes: v('s_inboxEveryMinutes'), followUpDays: v('s_followUpDays'),
      gmail: { user: v('s_user'), appPassword: v('s_pass') },
      profile: Object.fromEntries(PF.map((k) => [k, v('s_' + k)])),
    };
    if (body.mode === 'auto' && S.config.mode !== 'auto' && !confirm('الإرسال التلقائي: أي وظيفة فوق حد التطابق بتنرسل من جيميلك بدون ما أرجع لك. أكيد؟')) return;
    return act(t, async () => {
      await call('/api/config', body);
      if (body.gmail.appPassword || body.gmail.user !== S.config.gmail.user) await call('/api/gmail/test', { gmail: body.gmail });
      document.activeElement.blur();
    }, 'انحفظت الإعدادات.');
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id !== 's_cv' || !e.target.files[0]) return;
  const f = e.target.files[0];
  act(null, async () => {
    await call('/api/cv', f, { raw: true, headers: { 'X-Filename': encodeURIComponent(f.name), 'Content-Type': 'application/octet-stream' } });
    if (/\.pdf$/i.test(f.name)) call('/api/cv/read').catch(() => {});
    await refresh();
  }, 'انرفعت السيرة الجديدة.');
});

async function runUpdate(btn) {
  btn.disabled = true;
  toast('ينزّل التحديث…');
  try {
    const out = await call('/api/update/install');
    if (!out.updated) return toast('أنت على آخر نسخة.'), refresh().then(() => render());
    toast('انركّب التحديث. يعيد التشغيل…');
    // ننتظر النسخة الجديدة تشتغل ثم نعيد تحميل الصفحة
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const s = await (await fetch('/api/state')).json();
        if (s.version === out.build) return location.reload();
      } catch (_) {}
    }
    toast('التحديث نزل بس البرنامج ما رجع يشتغل. افتحه من أيقونة سطح المكتب.', true);
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
  }
}

// يرجّع true لو البيانات تغيّرت. لو ما تغيّر شي، الخادم يرد برد صغير وما نعيد رسم الصفحة.
async function refresh(force) {
  const res = await fetch('/api/state' + (S && !force ? '?sig=' + encodeURIComponent(S.sig) : ''));
  const data = await res.json();
  if (data.same) return false;
  S = data;
  return true;
}

(async function boot() {
  try {
    await refresh();
  } catch (e) {
    document.body.innerHTML = '<p style="padding:3rem;font-family:sans-serif">راصد مو شغّال. شغّله من PowerShell بالأمر: npm start</p>';
    return;
  }
  if (S.config.setupDone) showApp();
  else {
    $('#wizard').hidden = false;
    initWizard();
  }
  setInterval(() => refresh().then((changed) => render(!changed)).catch(() => {}), 5000);
})();
