// أوامر التغيير اللي يقدر راصد ينفّذها من المحادثة، مع الحمايات.
const store = require('./store');
const mailer = require('./mailer');

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i;
const SETTINGS = ['mode', 'minFit', 'dailyCap', 'searchHour', 'inboxEveryMinutes', 'followUpDays', 'letterLanguage', 'voice', 'digestEveryHours', 'autoAI'];
const PROFILE = ['nickname', 'birthDate', 'phone', 'location', 'linkedin', 'headline', 'summary', 'targets', 'avoid', 'noticePeriod', 'extra'];

// ينفّذ أمر واحد بعد التحقق منه. يرجّع وصف اللي صار، أو يرمي خطأ.
async function execute(a, d, deps, said = '') {
  // حماية: أي إيميل جديد لازم يكون مكتوب بيدك في رسالتك، والإرسال لازم تطلبه صراحة
  const typed = (e) => said.toLowerCase().includes(String(e).toLowerCase());
  const job = a.jobId ? d.jobs.find((j) => j.id === a.jobId) : null;
  const need = () => {
    if (!job) throw new Error('ما لقيت الوظيفة');
    return job;
  };
  const name = () => `«${job.title}» في ${job.company}`;
  switch (a.type) {
    case 'edit_draft': {
      need();
      if (job.sentAt) throw new Error(`${name()} انرسلت خلاص وما تتعدل`);
      if (!job.draft) throw new Error(`${name()} ما لها رسالة مكتوبة بعد`);
      const subject = String(a.subject || '').replace(/[\r\n]+/g, ' ').trim();
      const body = String(a.body || '').trim();
      if (body.length < 40) throw new Error('النص الجديد ناقص');
      if (subject) job.draft.subject = subject.slice(0, 200);
      job.draft.body = body;
      job.draft.at = Date.now();
      return `عدّلت رسالة ${name()}`;
    }
    case 'set_apply_email': {
      need();
      if (job.sentAt) throw new Error(`${name()} انرسلت خلاص`);
      const e = String(a.email || '').trim();
      if (!EMAIL_RE.test(e)) throw new Error('الإيميل مو صحيح');
      if (!typed(e)) throw new Error('اكتب لي الإيميل نفسه في رسالتك عشان أغيّره');
      job.applyEmail = e;
      job.applyMethod = 'email';
      if (job.draft && ['manual', 'failed'].includes(job.status)) job.status = 'ready';
      return `غيّرت إيميل التقديم لـ ${name()} إلى ${e}`;
    }
    case 'send':
      need();
      if (!/رسل|قدّم|قدم|send|apply/i.test(said)) throw new Error('ما أرسل إلا لما تقول لي صراحة «أرسل»');
      await mailer.sendJob(job);
      deps.briefDirty();
      return `أرسلت التقديم على ${name()}`;
    case 'add_job': {
      const company = String(a.company || '').trim().slice(0, 200);
      if (!company) throw new Error('ما عرفت اسم الشركة');
      const email = String(a.email || '').trim();
      if (email && !EMAIL_RE.test(email)) throw new Error('الإيميل مو صحيح');
      if (email && !typed(email)) throw new Error('اكتب لي إيميل الشركة نفسه في رسالتك');
      const title = String(a.title || '').trim().slice(0, 200) || 'Speculative application';
      const key = (company + '|' + title).toLowerCase().replace(/[^a-z0-9\u0600-\u06ff|]+/g, ' ').trim();
      if (d.jobs.some((j) => j.key === key)) throw new Error(`«${title}» في ${company} موجودة عندي من قبل`);
      d.jobs.unshift({
        id: store.id(), key, title, company,
        location: String(a.location || '').slice(0, 120),
        url: /^https?:\/\//i.test(a.url || '') ? String(a.url) : '',
        source: 'أضفتها أنت', pass: 'manual', verified: true,
        applyMethod: email ? 'email' : 'portal', applyEmail: email,
        deadline: '', postedAt: '', language: 'en', fit: 100,
        why: 'أنت اخترتها', concerns: '',
        requirements: String(a.requirements || '').slice(0, 1200),
        companyAbout: String(a.companyAbout || '').slice(0, 300),
        foundAt: Date.now(), status: 'new', draft: null, sentAt: 0, messageId: '', lastError: '',
      });
      deps.draftNow();
      return `أضفت ${company}${email ? ' (' + email + ')' : ''} وأكتب لها رسالة التقديم الحين`;
    }
    case 'skip':
      need();
      if (job.sentAt) throw new Error(`${name()} انرسلت خلاص`);
      job.status = 'skipped';
      return `تجاهلت ${name()}`;
    case 'restore':
      need();
      if (job.status !== 'skipped') throw new Error(`${name()} مو متجاهلة`);
      job.status = job.draft ? (job.applyEmail ? 'ready' : 'manual') : 'new';
      return `رجّعت ${name()}`;
    case 'mark_done':
      need();
      if (job.sentAt) throw new Error(`${name()} مسجّلة من قبل`);
      job.status = 'manual_done';
      job.sentAt = Date.now();
      return `سجّلت إنك قدّمت على ${name()}`;
    case 'settings': {
      const v = Object.fromEntries(Object.entries(a.values || {}).filter(([k]) => SETTINGS.includes(k)));
      if (!Object.keys(v).length) throw new Error('ما في إعداد معروف أغيّره');
      deps.applyConfig(v);
      return 'غيّرت الإعدادات: ' + Object.keys(v).join('، ');
    }
    case 'profile': {
      const v = Object.fromEntries(Object.entries(a.values || {}).filter(([k, x]) => PROFILE.includes(k) && typeof x === 'string'));
      if (!Object.keys(v).length) throw new Error('ما في معلومة معروفة أغيّرها');
      deps.applyConfig({ profile: v });
      return 'حدّثت معلوماتك: ' + Object.keys(v).join('، ');
    }
    case 'letter_notes':
      d.config.letterNotes = String(a.text || '').trim().slice(0, 600);
      return d.config.letterNotes ? 'حفظت ملاحظتك لكل الرسائل الجاية' : 'مسحت ملاحظات الرسائل';
    case 'run':
      if (a.what === 'inbox') {
        const n = await deps.run.inbox();
        return n ? `فحصت الإيميل: وصل ${n === 1 ? 'رد جديد' : n + ' ردود جديدة'} — تلقاها في صفحة الردود` : 'فحصت الإيميل: ما في ردود جديدة';
      } else if (a.what === 'search' || a.what === 'news') {
        if (deps.busy()) throw new Error('مشغول الحين: ' + deps.busy());
        deps.run[a.what]();
      } else throw new Error('أمر تشغيل غير معروف');
      return { search: 'بدأت البحث', news: 'أجمع الأخبار' }[a.what];
    default:
      throw new Error('أمر غير مسموح: ' + String(a.type).slice(0, 30));
  }
}

module.exports = { execute, SETTINGS, PROFILE };
