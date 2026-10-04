// خادم MCP صغير (stdio): يعطي Claude أدوات راصد في المحادثة. كل أداة تنفَّذ داخل البرنامج نفسه عبر عنوانه المحلي،
// فتبقى كل الحمايات (ما يرسل إلا بطلبك، ما يضيف إيميل ما كتبته) في مكان واحد.
const http = require('http');
const defs = require('./tooldefs');

const PORT = Number(process.env.RASID_PORT) || 4747;
const ACCOUNT = /^(main|[a-f0-9]{12})$/.test(process.env.RASID_ACCOUNT || '') ? process.env.RASID_ACCOUNT : 'main'; // الأدوات تشتغل على حساب المحادثة نفسه

function callProgram(name, args) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(args || {}), 'utf8');
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/api/tool/' + encodeURIComponent(name), method: 'POST', headers: { 'X-Rasid': '1', 'X-Rasid-Account': ACCOUNT, 'Content-Type': 'application/json', 'Content-Length': body.length }, timeout: 120000 },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ ok: res.statusCode === 200, text: out }));
      }
    );
    req.on('error', (e) => resolve({ ok: false, text: JSON.stringify({ error: 'program not reachable: ' + e.message }) }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, text: JSON.stringify({ error: 'timed out' }) });
    });
    req.end(body);
  });
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function onMessage(msg) {
  const { id, method, params } = msg;
  const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return reply({ protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'rasid', version: '1' } });
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: defs });
  if (method === 'tools/call') {
    const r = await callProgram(params && params.name, params && params.arguments);
    return reply({ content: [{ type: 'text', text: r.text }], isError: !r.ok });
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      onMessage(JSON.parse(line)).catch(() => {});
    } catch (_) {}
  }
});
process.stdin.on('end', () => process.exit(0));
