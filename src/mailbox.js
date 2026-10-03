// قراءة صندوق الجيميل كامل (الوارد + المرسل + الأرشيف) للمحادثة. قراءة فقط: ما يعلّم ولا يحذف ولا يرسل.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const store = require('./store');
const { explain } = require('./mailer');

const addr = (list) => (Array.isArray(list) && list[0] ? `${list[0].name ? list[0].name + ' ' : ''}<${list[0].address || ''}>` : '');
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '');

async function withAll(fn) {
  const cfg = store.load().config;
  if (!cfg.gmail.user || !cfg.gmail.appPassword) throw new Error('الجيميل مو مربوط بعد.');
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: cfg.gmail.user, pass: String(cfg.gmail.appPassword).replace(/\s+/g, '') },
    logger: false,
  });
  try {
    await client.connect();
  } catch (e) {
    throw new Error(explain(e.responseText ? new Error(e.responseText) : e));
  }
  try {
    // «كل البريد» اسمه يختلف حسب لغة الحساب: نلقاه بعلامته الخاصة
    const list = await client.list();
    const all = list.find((b) => b.specialUse === '\\All');
    const sent = list.find((b) => b.specialUse === '\\Sent');
    const box = await client.mailboxOpen(all ? all.path : 'INBOX', { readOnly: true });
    return await fn(client, { box, allPath: all ? all.path : 'INBOX', sentPath: sent ? sent.path : '', wholeMailbox: !!all, me: cfg.gmail.user.toLowerCase() });
  } finally {
    await client.logout().catch(() => {});
  }
}

const row = (m, me) => {
  const e = m.envelope || {};
  const from = (e.from && e.from[0] && e.from[0].address) || '';
  const sent = from.toLowerCase() === me || (m.labels && [...m.labels].some((l) => /sent/i.test(l)));
  return { uid: m.uid, date: iso(e.date || m.internalDate), direction: sent ? 'sent by him' : 'received', from: addr(e.from), to: addr(e.to), subject: String(e.subject || '').slice(0, 160) };
};

async function overview() {
  if (process.env.RASID_MOCK_MAIL) return require('../test/mailfix').overview();
  return withAll(async (client, ctx) => {
    const out = { account: ctx.me, scope: ctx.wholeMailbox ? 'all mail (inbox + sent + archive)' : 'inbox only (the All Mail folder is hidden from IMAP in Gmail settings)', total_messages: ctx.box.exists };
    if (ctx.box.exists) {
      const first = await client.fetchOne('1', { envelope: true, internalDate: true });
      const last = await client.fetchOne('*', { envelope: true, internalDate: true });
      out.oldest_message = first ? iso((first.envelope && first.envelope.date) || first.internalDate) : '';
      out.newest_message = last ? iso((last.envelope && last.envelope.date) || last.internalDate) : '';
    }
    try {
      const inbox = await client.status('INBOX', { messages: true, unseen: true });
      out.inbox = { messages: inbox.messages, unread: inbox.unseen };
      if (ctx.sentPath) out.sent_messages = (await client.status(ctx.sentPath, { messages: true })).messages;
    } catch (_) {}
    return out;
  });
}

async function search({ query = '', limit = 30, offset = 0 } = {}) {
  limit = Math.max(1, Math.min(60, Number(limit) || 30));
  offset = Math.max(0, Number(offset) || 0);
  if (process.env.RASID_MOCK_MAIL) return require('../test/mailfix').search(String(query), limit, offset);
  return withAll(async (client, ctx) => {
    const q = String(query).trim();
    let uids = (await client.search(q ? { gmraw: q } : { all: true }, { uid: true })) || [];
    uids = uids.sort((a, b) => b - a);
    const page = uids.slice(offset, offset + limit);
    const items = [];
    if (page.length) for await (const m of client.fetch(page, { uid: true, envelope: true, internalDate: true, labels: true }, { uid: true })) items.push(row(m, ctx.me));
    items.sort((a, b) => b.uid - a.uid);
    return { query: q, total: uids.length, showing: `${offset + 1}-${offset + items.length}`, more: offset + items.length < uids.length, items };
  });
}

async function parse(m, me, max) {
  const p = await simpleParser(m.source);
  const from = (p.from && p.from.value && p.from.value[0]) || {};
  const text = (p.text || String(p.html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return {
    uid: m.uid,
    date: iso(p.date),
    direction: String(from.address || '').toLowerCase() === me ? 'sent by him' : 'received',
    from: `${from.name ? from.name + ' ' : ''}<${from.address || ''}>`,
    to: p.to ? p.to.text : '',
    subject: p.subject || '',
    attachments: (p.attachments || []).map((a) => a.filename).filter(Boolean),
    text: text.length > max ? text.slice(0, max) + '\n[... trimmed]' : text,
  };
}

async function read({ uid } = {}) {
  uid = Number(uid);
  if (!uid) throw new Error('uid ناقص');
  if (process.env.RASID_MOCK_MAIL) return require('../test/mailfix').read(uid);
  return withAll(async (client, ctx) => {
    const m = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
    if (!m) throw new Error('ما لقيت الرسالة ' + uid);
    return parse(m, ctx.me, 8000);
  });
}

async function thread({ uid } = {}) {
  uid = Number(uid);
  if (!uid) throw new Error('uid ناقص');
  if (process.env.RASID_MOCK_MAIL) return require('../test/mailfix').thread(uid);
  return withAll(async (client, ctx) => {
    const head = await client.fetchOne(String(uid), { uid: true, threadId: true, envelope: true }, { uid: true });
    if (!head) throw new Error('ما لقيت الرسالة ' + uid);
    let uids = [uid];
    try {
      if (head.threadId) uids = (await client.search({ threadId: head.threadId }, { uid: true })) || [uid];
    } catch (_) {}
    uids = uids.sort((a, b) => a - b).slice(-12);
    const messages = [];
    for await (const m of client.fetch(uids, { uid: true, source: true }, { uid: true })) messages.push(await parse(m, ctx.me, 2500));
    messages.sort((a, b) => a.uid - b.uid);
    return { messages_in_thread: messages.length, messages };
  });
}

module.exports = { overview, search, read, thread };
