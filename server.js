// ─────────────────────────────────────────────────────────────────────────
// Jev flow harness — LOCAL ONLY. Standalone; touches no firmware.
//
// Serves the node-editor UI and proxies BOTH the Jev API and the LLM APIs
// server-side. All three (TypeSafe, OpenAI, Gemini) refuse browser calls
// (CORS), so the browser talks only to this localhost process, which forwards
// over TLS. Your API keys go from here straight to each provider, never through
// any third party. This mirrors how the ESP32 firmware would call them.
//
// Run:  node server.js   →  open http://localhost:7878
// Zero npm dependencies (Node built-in http/https/fs only).
// ─────────────────────────────────────────────────────────────────────────
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = 7878;
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'));

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Read + JSON-parse a request body, then hand it to cb. Caps at 4MB.
function readBody(req, res, cb) {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 4e6) req.destroy(); });
  req.on('end', () => {
    let j;
    try { j = JSON.parse(raw); } catch (e) { send(res, 400, { error: 'bad request JSON' }); return; }
    cb(j);
  });
}

// One outbound HTTPS request; onDone(bodyString, status, ms). Errors -> 200 with {status:0,error}.
function proxy(opts, body, res, onDone) {
  const t0 = Date.now();
  const preq = https.request(opts, pres => {
    let data = '';
    pres.on('data', d => data += d);
    pres.on('end', () => onDone(data, pres.statusCode, Date.now() - t0));
  });
  preq.on('error', e => send(res, 200, { status: 0, error: String(e && e.message || e) }));
  preq.write(body);
  preq.end();
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  // ── Jev (TypeSafe) ──────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/jev') {
    readBody(req, res, j => {
      if (!j.apiKey)  return send(res, 400, { error: 'missing Jev API key' });
      if (!j.payload) return send(res, 400, { error: 'missing payload' });
      const body = JSON.stringify(j.payload);
      proxy({
        method: 'POST', hostname: 'api.typesafe.ai', path: '/v1/systemone',
        headers: { 'Authorization': 'Bearer ' + j.apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, body, res, (data, status, ms) => send(res, 200, { status, ms, body: data }));
    });
    return;
  }

  // ── LLM (OpenAI or Gemini) ──────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/llm') {
    readBody(req, res, j => {
      const { apiKey, provider, model, temperature, system, prompt, messages } = j;
      if (!apiKey) return send(res, 400, { error: 'missing LLM API key' });
      const temp = Number(temperature); const t = isNaN(temp) ? 0.7 : temp;
      // Full multi-turn history when supplied (so the LLM sees its own prior
      // answers + Jev's critiques and actually adapts), else a single prompt.
      const turns = (Array.isArray(messages) && messages.length)
        ? messages.filter(m => m && m.role !== 'system')
        : [{ role: 'user', content: prompt || '' }];

      if (provider === 'gemini') {
        const payload = {
          contents: turns.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content || '') }] })),
          generationConfig: { temperature: t },
        };
        if (system) payload.systemInstruction = { parts: [{ text: system }] };
        const body = JSON.stringify(payload);
        proxy({
          method: 'POST', hostname: 'generativelanguage.googleapis.com',
          path: '/v1beta/models/' + encodeURIComponent(model || 'gemini-3.5-flash-lite') + ':generateContent?key=' + encodeURIComponent(apiKey),
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, body, res, (data, status, ms) => {
          let text = '';
          try { const p = JSON.parse(data); text = (((p.candidates || [])[0] || {}).content || {}).parts?.map(x => x.text || '').join('') || ''; } catch (e) {}
          send(res, 200, { status, ms, text, raw: data });
        });
      } else {
        const msgs = [];
        if (system) msgs.push({ role: 'system', content: system });
        turns.forEach(m => msgs.push({ role: m.role, content: String(m.content || '') }));
        const body = JSON.stringify({ model: model || 'gpt-4o-mini', messages: msgs, temperature: t });
        proxy({
          method: 'POST', hostname: 'api.openai.com', path: '/v1/chat/completions',
          headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, body, res, (data, status, ms) => {
          let text = '';
          try { const p = JSON.parse(data); text = (((p.choices || [])[0] || {}).message || {}).content || ''; } catch (e) {}
          send(res, 200, { status, ms, text, raw: data });
        });
      }
    });
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`\n  Jev flow harness  →  http://localhost:${PORT}\n  (Ctrl+C to stop)\n`);
});
