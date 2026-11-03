import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { complete, streamCompletion } from './providers.mjs';

function authorized(header, token) {
  const incoming = Buffer.from(header ?? ''), expected = Buffer.from(`Bearer ${token}`);
  return incoming.length === expected.length && timingSafeEqual(incoming, expected);
}
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
function fail(res, status, message) { json(res, status, { error: { message, type: 'api_error', code: status } }); }
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 5 * 1024 * 1024) throw Object.assign(new Error('Request exceeds 5 MB.'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Request must contain valid JSON.'), { status: 400 }); }
}
export class Gateway {
  constructor({ getProviders, getProvider, onChange = () => {} }) {
    this.getProviders = getProviders; this.getProvider = getProvider; this.onChange = onChange; this.server = null; this.startPromise = null; this.controllers = new Set(); this.info = { running: false, port: 4318, url: 'http://127.0.0.1:4318/v1' };
  }
  status() { return { ...this.info }; }
  async start({ port, token }) {
    if (this.server) return this.status();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.listen({ port, token });
    try { return await this.startPromise; } finally { this.startPromise = null; }
  }
  async listen({ port, token }) {
    if (!Number.isInteger(port) || port < 0 || port > 65535 || typeof token !== 'string' || token.length < 16) throw new Error('Valid port and a gateway token of at least 16 characters are required.');
    this.token = token;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch(() => { if (!res.headersSent) fail(res, 500, 'Gateway request failed.'); else res.destroy(); });
    });
    server.requestTimeout = 120000; server.headersTimeout = 15000; server.keepAliveTimeout = 5000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    this.server = server; const actualPort = server.address().port;
    this.info = { running: true, port: actualPort, url: `http://127.0.0.1:${actualPort}/v1` }; this.onChange(); return this.status();
  }
  async stop() {
    if (this.startPromise) { try { await this.startPromise; } catch { /* No server was created. */ } }
    for (const controller of this.controllers) controller.abort();
    if (this.server) { const server = this.server; this.server = null; await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
    this.info.running = false; this.onChange(); return this.status();
  }
  selectModel(model, providerId) {
    const providers = this.getProviders();
    let p, id = model;
    if (providerId) {
      p = providers.find(x => x.id === providerId);
      if (!p) throw Object.assign(new Error('Unknown provider_id.'), { status: 404 });
      if (model?.startsWith(`${p.id}/`)) id = model.slice(p.id.length + 1);
    }
    if (!p && model?.includes('/')) { p = providers.find(x => model.startsWith(`${x.id}/`)); if (p) id = model.slice(p.id.length + 1); }
    if (!p) p = providers.find(x => x.models?.includes(model)) ?? (!model ? providers[0] : undefined);
    if (!p) throw Object.assign(new Error('Unknown model. Use GET /v1/models or specify provider_id with a custom model ID.'), { status: 404 });
    const provider = this.getProvider(p.id);
    const url = new URL(provider.baseUrl);
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === this.info.port) throw Object.assign(new Error('Provider base URL points back to this gateway.'), { status: 400 });
    return { provider, model: id || provider.defaultModel };
  }
  async handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // No browser origins are trusted. Native clients authenticate with the token.
    if (req.headers.origin) { fail(res, 403, 'Browser cross-origin requests are disabled.'); return; }
    if (url.pathname === '/health' && req.method === 'GET') { json(res, 200, { status: 'ok', service: 'antigravity-studio' }); return; }
    if (!authorized(req.headers.authorization, this.token)) { fail(res, 401, 'A valid gateway bearer token is required.'); return; }
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      json(res, 200, { object: 'list', data: this.getProviders().flatMap(p => p.models.map(id => ({ id: `${p.id}/${id}`, object: 'model', created: 0, owned_by: p.name }))) }); return;
    }
    if (url.pathname !== '/v1/chat/completions' || req.method !== 'POST') { fail(res, 404, 'Available endpoints: GET /health, GET /v1/models, POST /v1/chat/completions.'); return; }
    if (this.controllers.size >= 16) { fail(res, 429, 'Too many concurrent requests.'); return; }
    const controller = new AbortController(); this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(new Error('Upstream timed out after 5 minutes.')), 300000);
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Request must be a JSON object.'), { status: 400 });
      if ((body.model !== undefined && typeof body.model !== 'string') || (body.provider_id !== undefined && typeof body.provider_id !== 'string') || (body.stream !== undefined && typeof body.stream !== 'boolean')) throw Object.assign(new Error('model and provider_id must be strings; stream must be a boolean.'), { status: 400 });
      if (!Array.isArray(body.messages) || !body.messages.length) throw Object.assign(new Error('messages must be a nonempty array.'), { status: 400 });
      if (body.messages.some(m => !m || typeof m !== 'object' || !['system', 'developer', 'user', 'assistant', 'tool'].includes(m.role))) throw Object.assign(new Error('Every message must have a valid role.'), { status: 400 });
      const { provider, model } = this.selectModel(body.model, body.provider_id);
      const { provider_id, ...request } = body; request.model = model;
      if (body.stream) {
        let began = false;
        for await (const chunk of streamCompletion(provider, request, { signal: controller.signal })) {
          if (!began) { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); began = true; }
          if (!res.write(`data: ${JSON.stringify(chunk)}\n\n`)) await once(res, 'drain', { signal: controller.signal });
        }
        if (!began) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.end('data: [DONE]\n\n');
      } else json(res, 200, await complete(provider, { ...request, stream: false }, { signal: controller.signal }));
    } catch (error) {
      const message = String(error.message || 'Upstream request failed.').slice(0, 1500);
      if (!res.headersSent) fail(res, error.status || 502, message);
      else if (!res.destroyed) res.end(`data: ${JSON.stringify({ error: { message } })}\n\ndata: [DONE]\n\n`);
    } finally { clearTimeout(timeout); this.controllers.delete(controller); }
  }
}
