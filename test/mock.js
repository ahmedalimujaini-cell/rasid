// ردود ثابتة للاختبار بدون Claude (RASID_MOCK=1).
const jobs = {
  'discover:employers': [
    { title: 'Artificial Lift Engineer', company: 'Test Operator LLC', location: 'Muscat', url: 'https://example.com/jobs/1', source: 'careers page', applyMethod: 'email', applyEmail: 'careers@test-operator.example', language: 'en', fit: 88, why: 'خبرتك في ESP مطابقة', concerns: '', requirements: 'ESP installation, 5+ years' },
    { title: 'Wellsite Supervisor', company: 'Portal Only Co', location: 'Nizwa', url: 'https://example.com/jobs/2', source: 'careers page', applyMethod: 'portal', applyEmail: '', language: 'en', fit: 81, why: 'إشراف ميداني', concerns: 'يطلبون شهادة IWCF', requirements: 'Wellsite supervision' },
  ],
  'discover:public': [
    { title: 'Field Service Lead', company: 'Lift Services', location: 'Fahud', url: 'https://example.com/jobs/3', source: 'Bayt', applyMethod: 'email', applyEmail: 'hr@lift-services.example', language: 'en', fit: 76, why: 'قيادة فرق ميدانية', concerns: '', requirements: 'Lead ESP crews' },
    { title: 'Fake Job', company: 'No Url Inc', location: 'Oman', url: '', applyEmail: 'x@y.example', fit: 99 },
    { title: 'Accountant', company: 'Ledger Co', location: 'Muscat', url: 'https://example.com/jobs/4', applyEmail: 'not-an-email', fit: 20, why: '', requirements: '' },
  ],
  'discover:boards': [
    { title: 'Artificial Lift Engineer', company: 'Test Operator LLC', location: 'Muscat', url: 'https://example.com/jobs/1b', applyEmail: 'careers@test-operator.example', fit: 88 },
  ],
  'discover:adjacent': [
    { title: 'ESP Technician', company: 'Unopened Co', location: 'Oman', url: 'https://example.com/jobs/9', applyEmail: 'jobs@unopened.example', verified: false, fit: 90, why: '', requirements: '' },
  ],
};
exports.calls = {};
exports.models = {}; // آخر موديل/مستوى تفكير طُلب لكل نوع (للتأكد من التوفير)
exports.reply = (key, prompt, opts = {}) => {
  exports.calls[key] = (exports.calls[key] || 0) + 1;
  exports.models[key] = [opts.model, opts.effort].filter(Boolean).join('/') || 'default';
  if (key === 'directory')
    return {
      companies: [
        { company: 'Batinah Builders', location: 'Sohar', url: 'https://example.com/bb', applyEmail: 'hr@batinah-builders.example', verified: true, fit: 80, suggestedRole: 'Junior Quantity Surveyor', why: '', companyAbout: 'مقاول في صحار' },
        { company: 'Form Only Co', location: 'Muscat', url: 'https://example.com/form', applyEmail: '', fit: 75, applySteps: 'افتح صفحة Careers واضغط Apply' },
        { company: 'Guessed Email Co', url: 'https://example.com/g', applyEmail: 'hr@guessed.example', verified: false, fit: 90 },
        { company: 'Test Operator LLC', url: 'https://example.com/dup', applyEmail: 'careers@test-operator.example', verified: true, fit: 90 },
        { company: 'Nothing Co', url: '', applyEmail: '', fit: 90 },
      ],
    };
  if (key && key.startsWith('discover:')) return { jobs: jobs[key] || [], notes: 'اختبار' };
  if (key === 'draft:specbase') return { subject: 'Junior Quantity Surveyor – Test User – CV for your consideration', body: 'Dear Hiring Manager,\n\nI would like to be considered for a Junior Quantity Surveyor role at {{COMPANY}}. I completed on-the-job training in quantity surveying.\n\nYours sincerely,\nTest User' };
  if (key === 'draft:application') return { subject: 'Application — test role', body: 'Dear Hiring Team,\n\nI am applying for the role. I led offshore ESP installations in Oman.\n\nRegards,\nTest User', language: 'en' };
  if (key === 'draft:followup') return { subject: 'Following up on my application', body: 'Dear Hiring Team,\n\nI applied recently and remain interested in the role.\n\nRegards,\nTest User', language: 'en' };
  if (key === 'classify') {
    const interview = /interview/i.test(prompt);
    return { category: interview ? 'interview' : 'auto_reply', jobRelated: true, summary: interview ? 'يدعونك لمقابلة' : 'استلموا طلبك', action: interview ? 'رد عليهم بالموعد المناسب' : '' };
  }
  if (key === 'agent') return global.__agent ? global.__agent(prompt) : { calls: [], text: 'تم.' };
  if (key === 'brief') return { script: 'يا أحمد، قدّمت لك اليوم على وظيفتين في مسقط. وصلك رد واحد يدعونك لمقابلة.' };
  if (key === 'news') return { news: [{ title: 'عقد جديد', summary: 'ملخص', why: 'يعني توظيف', url: 'https://example.com/news/1', source: 'Test', date: '2026-10-01' }, { title: 'بدون رابط', url: '' }] };
  if (key === 'selftest') return { ok: true };
  if (key === 'cv') return { name: 'Test User', phone: '+968 0000', headline: 'ESP Specialist', summary: 'Summary', targets: 'ESP', cvText: 'CV text' };
  return {};
};
