// ربط راصد بـClaude Code في السحابة (Routine بتشغيل API).
// لما تطلب من «كلّم راصد» تعديل على البرنامج نفسه، الطلب يروح لجلسة Claude Code تسويه وتختبره وتنشره، وراصد يحدّث نفسه لحاله.
// الرابط والمفتاح محليين في data/ للحساب الرئيسي (مثل كلمة سر الجيميل): المفتاح ما يطلع للواجهة ولا لـClaude ولا للسجل.
const https = require('https');
const store = require('./store');

const URL_RE = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]{8,64}\/fire$/;
const TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]{20,400}$/;
const PER_DAY = 6; // حد طلبات التعديل في اليوم لكل الحسابات (كل طلب جلسة كاملة من اشتراكك)

const link = () => store.load(store.MAIN).config.devLink || { url: '', token: '' };
const ready = () => URL_RE.test(link().url || '') && TOKEN_RE.test(link().token || '');

// للواجهة: بدون المفتاح
function info() {
  const l = link();
  return { url: l.url || '', hasToken: !!l.token, ready: ready() };
}

// يحفظ الرابط والمفتاح. رابط فاضي = يفك الربط. مفتاح فاضي = يخلّي المحفوظ.
function save(url, token) {
  url = String(url || '').trim();
  token = String(token || '').trim();
  if (url && !URL_RE.test(url)) throw new Error('الرابط مو صحيح. انسخه كامل من صفحة الـRoutine، يبدأ بـ https://api.anthropic.com/v1/claude_code/routines/');
  if (token && !TOKEN_RE.test(token)) throw new Error('المفتاح مو صحيح. انسخه كامل، يبدأ بـ sk-ant-oat01-');
  const c = store.load(store.MAIN).config;
  const old = c.devLink || {};
  c.devLink = url ? { url, token: token || old.token || '' } : { url: '', token: '' };
  store.save();
  return info();
}

function post(url, token, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text });
    const req = https.request(url, {
      method: 'POST',
      timeout: 30000,
      headers: { Authorization: 'Bearer ' + token, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

// يرسل طلب التعديل. said = رسالة المستخدم نفسها (الطلب لازم يجي منه). send قابل للتبديل في الاختبار.
async function requestChange(request, said, send = post) {
  request = String(request || '').trim().slice(0, 4000);
  said = String(said || '').trim().slice(0, 2000);
  if (!said) throw new Error('طلب التعديل لازم يكون من رسالتك أنت');
  if (request.length < 10) throw new Error('اكتب الطلب بوضوح أكثر');
  if (!ready()) throw new Error('ربط راصد بـClaude مو مفعّل. من الإعدادات في الحساب الرئيسي، قسم «ربط راصد بـClaude»، حط الرابط والمفتاح مرة وحدة.');
  const main = store.load(store.MAIN);
  const day = new Date().toISOString().slice(0, 10);
  if (!Array.isArray(main.state.devRequests)) main.state.devRequests = [];
  const list = main.state.devRequests;
  if (list.filter((r) => r.day === day).length >= PER_DAY) throw new Error(`وصلت حد ${PER_DAY} طلبات تعديل في اليوم. كمّل بكرة.`);
  let build = '';
  try { build = require('./update').local().build; } catch (_) {}
  const text = [
    `طلب تعديل على برنامج راصد من «كلّم راصد» (${store.current() === store.MAIN ? 'الحساب الرئيسي' : 'حساب إضافي'}، النسخة ${build}).`,
    'الطلب كما فهمه راصد:',
    '<request>', request, '</request>',
    'كلام المستخدم بالحرف:',
    '<said>', said, '</said>',
    'هذا كلام المستخدم، ونفّذه حسب CLAUDE.md بدون ما تتجاوز قواعده. لا ترفع أي بيانات شخصية منه للمستودع.',
  ].join('\n');
  const l = link();
  let r;
  try {
    r = await send(l.url, l.token, text);
  } catch (e) {
    throw new Error('ما قدرت أوصل Claude الحين: ' + String(e.message || e).slice(0, 80));
  }
  const why = { 400: 'الـRoutine موقّف أو الطلب طويل. شيّكه في claude.ai/code/routines', 401: 'المفتاح ما انقبل. ولّد مفتاح جديد من صفحة الـRoutine وحطه في الإعدادات', 403: 'حسابك في Claude ما يسمح بهالتشغيل', 404: 'الـRoutine مو موجود. شيّك على الرابط في الإعدادات', 429: 'وصلت حد التشغيل في الساعة. جرّب بعد شوي' }[r.status];
  if (why) throw new Error(why);
  if (!(r.status >= 200 && r.status < 300)) throw new Error(`Claude ما قبل الطلب (${r.status}). جرّب بعد شوي`);
  const url = r.json && /^https:\/\/claude\.ai\//.test(String(r.json.claude_code_session_url || '')) ? r.json.claude_code_session_url : '';
  list.unshift({ day, t: Date.now(), account: store.current(), request: request.slice(0, 300), url });
  if (list.length > 30) list.length = 30;
  store.save();
  store.event('info', 'أرسلت طلب تعديل للمطوّر: ' + request.slice(0, 140));
  return { sent: true, follow_link: url, next: 'Claude Code is now implementing, testing and publishing it. Rasid installs the update by itself a few minutes after it is published, and the update note says what changed. Tell him that, with the link.' };
}

// آخر الطلبات للواجهة: الحساب الرئيسي يشوف الكل، والحساب الإضافي طلباته بس
function recent() {
  const all = store.load(store.MAIN).state.devRequests || [];
  const me = store.current();
  return all.filter((r) => me === store.MAIN || r.account === me).slice(0, 8).map((r) => ({ t: r.t, request: r.request, url: r.url }));
}

module.exports = { info, save, ready, requestChange, recent, URL_RE, TOKEN_RE, PER_DAY };
