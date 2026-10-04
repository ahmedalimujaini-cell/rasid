// تعريف أدوات راصد اللي يستخدمها Claude في المحادثة (بدون أي استيراد: يقراها خادم MCP والبرنامج).
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });

module.exports = [
  {
    name: 'program_status',
    description: 'Current state of the job-application program: counts of applications, what is waiting, unresolved problems, settings, last search and inbox check times, and the candidate profile.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'jobs_list',
    description: 'List jobs and companies the program knows, with status. Status values: sent (applied by email), manual_done (he applied himself), ready (letter written, waiting to send), manual (no email: he must apply on the company site), low (weak fit, not applied), skipped, failed, new.',
    inputSchema: { type: 'object', properties: { status: str('Optional status filter, or "applied" for sent+manual_done, or "not_applied" for everything else'), company: str('Optional: part of a company name'), limit: num('Max rows, default 60') } },
  },
  {
    name: 'job_details',
    description: 'Everything about one job: fit, reasons, apply email or link, apply steps, the full application email text, send date, and any reply.',
    inputSchema: { type: 'object', properties: { id: str('Job id from jobs_list') }, required: ['id'] },
  },
  {
    name: 'mail_overview',
    description: "Size and date range of the user's whole Gmail mailbox (all mail, inbox, sent): use it first when he asks about his email in general or 'from the first message'.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mail_search',
    description: "Search the user's WHOLE Gmail (inbox, sent and archive, all years) with Gmail search syntax, newest first. Examples: 'from:enco', 'to:hr@company.com', 'in:sent has:attachment', 'in:sent (application OR CV OR \"السيرة الذاتية\")', 'interview after:2026/01/01', 'subject:(job OR vacancy)'. Returns date, direction (received or sent), sender, recipient, subject and a uid for mail_read. Use offset to page through many results; total tells you how many matched.",
    inputSchema: { type: 'object', properties: { query: str('Gmail search query. Empty = every message.'), limit: num('Rows per page, default 30, max 60'), offset: num('Skip this many newest results (paging)') }, required: ['query'] },
  },
  {
    name: 'mail_read',
    description: 'Read the full text of one email by uid (from mail_search), with its attachment names.',
    inputSchema: { type: 'object', properties: { uid: num('uid from mail_search') }, required: ['uid'] },
  },
  {
    name: 'mail_thread',
    description: 'Read a whole conversation: every message in the same Gmail thread as this uid, oldest first, including what the user himself replied. Use it for "what happened with company X".',
    inputSchema: { type: 'object', properties: { uid: num('uid of any message in the thread') }, required: ['uid'] },
  },
  {
    name: 'do_action',
    description:
      'Change something in the program. action.type is one of: ' +
      'edit_draft {jobId, subject, body} rewrite an unsent application email (complete new text; only facts from his profile/CV); ' +
      'set_apply_email {jobId, email} (only an address the user typed himself); ' +
      'add_job {company, title, email, url, location, companyAbout, requirements} add a company so an application is written and sent (email only if the user typed it; empty email = manual application); ' +
      'send {jobId} send a ready application now (ONLY when the user explicitly says to send); ' +
      'skip {jobId}; restore {jobId}; mark_done {jobId} (he applied himself on the site); ' +
      'settings {values:{mode:"auto"|"review", minFit, dailyCap (daily target: the search stops once this many email applications are ready, and at most this many are sent per day), searchHour (0-23, the hour of the once-a-day search), inboxEveryMinutes, followUpDays, letterLanguage:"auto"|"en"|"ar", voice, digestEveryHours, autoAI (true = search by itself once a day at searchHour; false = search only when he asks, to save his Claude usage)}}; ' +
      'profile {values:{nickname, birthDate, phone, location, linkedin, headline, summary, targets, avoid, noticePeriod, extra}}; ' +
      'letter_notes {text} standing instruction for all future application emails; ' +
      'run {what:"search"|"inbox"|"news"} start a job search, check for new replies now, or refresh news. ' +
      'Returns what was done, or the reason it was refused.',
    inputSchema: { type: 'object', properties: { action: { type: 'object', description: 'The action object, with its type field.' } }, required: ['action'] },
  },
];
