import http from 'node:http';
import { parseSiteResult } from '../browser-extension/core.mjs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

// Protocol 3 sends visible website text for one authoritative desktop parse.
export const CONNECTOR_PROTOCOL = 3;
const EXTENSION_UPGRADE_MESSAGE = 'The Chrome extension is outdated or incompatible. In Settings → Browser Connector, click Open extension setup, then load the prepared folder in Chrome or reload the extension if it already uses that folder. Connect to app and approve it again if prompted.';

export const BROWSER_SITES = Object.freeze([
  { id: 'claude', model: 'claude-web', name: 'Claude' },
  { id: 'chatgpt', model: 'chatgpt-web', name: 'ChatGPT' },
  { id: 'deepseek', model: 'deepseek-web', name: 'DeepSeek' },
  { id: 'qwen', model: 'qwen-web', name: 'Qwen' },
  { id: 'zai', model: 'zai-web', name: 'Z.ai' },
  { id: 'gemini', model: 'gemini-web', name: 'Gemini' },
].map(Object.freeze));

const SITE_IDS = new Set(BROWSER_SITES.map(site => site.id));
const MAX_TEXT = 100000;
const MAX_BODY = 512 * 1024;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const failure = (status, message) => Object.assign(new Error(message), { status });
const equal = (left, right) => typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const bearer = (header, token) => !!token && equal(header, `Bearer ${token}`);

function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function bodyFor(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw failure(415, 'Use Content-Type: application/json.');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw failure(413, 'Request exceeds the connector size limit.');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure(400, 'Request must contain valid JSON.'); }
  if (!record(body)) throw failure(400, 'Request must be a JSON object.');
  return body;
}

function onlyKeys(value, keys) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw failure(400, 'Request contains unsupported fields.');
}

function text(value, label, maximum = MAX_TEXT, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || (!allowEmpty && !value.trim())) throw failure(400, `${label} must be ${allowEmpty ? '' : 'nonempty '}text of up to ${maximum} characters.`);
  return value;
}

function callList(calls, allowed, choice) {
  if (!Array.isArray(calls) || calls.length > 32) throw failure(400, 'Tool calls must be an array of up to 32 function calls.');
  const ids = new Set();
  return calls.map(call => {
    if (!record(call) || call.type !== 'function' || !record(call.function) || typeof call.function.name !== 'string' || !TOOL_NAME.test(call.function.name)) throw failure(400, 'Invalid function tool call.');
    const id = text(call.id, 'Tool call ID', 200);
    if (ids.has(id)) throw failure(400, 'Tool call IDs must be unique.');
    ids.add(id);
    const args = text(call.function.arguments, 'Tool arguments', MAX_TEXT, true);
    let parsed; try { parsed = JSON.parse(args); } catch { throw failure(400, 'Tool arguments must contain valid JSON.'); }
    if (!record(parsed)) throw failure(400, 'Tool arguments must be a JSON object.');
    if (allowed && (!allowed.has(call.function.name) || choice === 'none' || (record(choice) && choice.function.name !== call.function.name))) throw failure(400, 'The result requested a function that this job did not allow.');
    return { id, type: 'function', function: { name: call.function.name, arguments: args } };
  });
}

function normalizeCompletion(body) {
  const site = BROWSER_SITES.find(site => site.model === body.model);
  if (!site) throw failure(404, 'Unknown browser model alias. Use GET /v1/models; website model selection remains in Chrome.');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw failure(400, 'stream must be a boolean.');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 256) throw failure(400, 'messages must contain 1–256 messages.');
  let size = 0;
  const messages = body.messages.map(message => {
    if (!record(message) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) throw failure(400, 'Every message must have a valid role.');
    let content = message.content;
    if (Array.isArray(content)) {
      if (content.some(part => !record(part) || part.type !== 'text' || typeof part.text !== 'string')) throw failure(400, 'Browser connectors support text messages only. Attachments and image inputs are not supported.');
      content = content.map(part => part.text).join('\n');
    }
    if (content === null && message.role === 'assistant') content = '';
    content = text(content, 'Message content', MAX_TEXT, true);
    const normalized = { role: message.role, content };
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant') throw failure(400, 'Only assistant messages may contain tool calls.');
      normalized.tool_calls = callList(message.tool_calls);
    }
    if (message.role === 'tool') normalized.tool_call_id = text(message.tool_call_id, 'Tool result ID', 200);
    if (message.name !== undefined) normalized.name = text(message.name, 'Message name', 200);
    size += JSON.stringify(normalized).length;
    return normalized;
  });
  let tools;
  const names = new Set();
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 64) throw failure(400, 'tools must be an array of up to 64 function definitions.');
    tools = body.tools.map(tool => {
      if (!record(tool) || tool.type !== 'function' || !record(tool.function) || typeof tool.function.name !== 'string' || !TOOL_NAME.test(tool.function.name) || names.has(tool.function.name)) throw failure(400, 'Tools must have unique valid function names.');
      names.add(tool.function.name);
      const description = tool.function.description === undefined ? '' : text(tool.function.description, 'Tool description', 10000, true);
      const parameters = tool.function.parameters ?? { type: 'object', properties: {} };
      if (!record(parameters)) throw failure(400, 'Function parameters must be a JSON schema object.');
      return { type: 'function', function: { name: tool.function.name, description, parameters } };
    });
    size += JSON.stringify(tools).length;
  }
  const choice = body.tool_choice;
  if (choice !== undefined && !['auto', 'none', 'required'].includes(choice)) {
    if (!record(choice) || choice.type !== 'function' || !record(choice.function) || !names.has(choice.function.name)) throw failure(400, 'Unsupported tool_choice or unknown selected function.');
  }
  if ((choice === 'required' || record(choice)) && !names.size) throw failure(400, 'tool_choice requires at least one tool.');
  if (size > MAX_TEXT) throw failure(413, 'Messages and tool definitions exceed the 100,000-character connector limit.');
  return { siteId: site.id, model: site.model, messages, ...(tools ? { tools } : {}), ...(choice === undefined ? {} : { tool_choice: record(choice) ? { type: 'function', function: { name: choice.function.name } } : choice }), stream: !!body.stream };
}

function normalizeResult(result, job) {
  if (!record(result)) throw failure(400, 'A result object is required.');
  onlyKeys(result, ['role', 'content', 'tool_calls']);
  if (result.role !== undefined && result.role !== 'assistant') throw failure(400, 'The result role must be assistant.');
  const content = result.content == null ? '' : text(result.content, 'Result content', MAX_TEXT, true);
  const allowed = new Set((job.payload.tools || []).map(tool => tool.function.name));
  const calls = result.tool_calls === undefined ? [] : callList(result.tool_calls, allowed, job.payload.tool_choice);
  if (!content.trim() && !calls.length) throw failure(422, 'The website returned an empty response. No successful completion was produced.');
  if (job.payload.tool_choice === 'required' && !calls.length) throw failure(422, 'The website did not return the required function call.');
  if (record(job.payload.tool_choice) && !calls.length) throw failure(422, 'The website did not return the selected function call.');
  if (content.length + JSON.stringify(calls).length > MAX_TEXT) throw failure(413, 'The website result exceeds the connector size limit.');
  return { role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls } : {}) };
}

export class BrowserConnector {
  constructor({ store, onChange = () => {}, onReady = () => {}, port = 4319, requestTimeoutMs = 180000, pairingTtlMs = 300000, heartbeatTimeoutMs = 45000 } = {}) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid browser connector port.');
    for (const value of [requestTimeoutMs, pairingTtlMs, heartbeatTimeoutMs]) if (!Number.isInteger(value) || value < 10 || value > 300000) throw new Error('Invalid connector timeout.');
    if (requestTimeoutMs > 180000) throw new Error('Browser connector request timeout cannot exceed 180 seconds.');
    this.store = store; this.onChange = onChange; this.onReady = onReady; this.port = port;
    this.requestTimeoutMs = requestTimeoutMs; this.pairingTtlMs = pairingTtlMs; this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.server = null; this.startPromise = null; this.stopPromise = null; this.startController = null;
    this.info = { running: false, url: `http://127.0.0.1:${port}/v1` };
    this.apiToken = null; this.pair = null; this.pending = new Map(); this.jobs = new Map(); this.cancelled = new Map(); this.rateLimits = new Map();
    this.sites = new Map(BROWSER_SITES.map(site => [site.id, { id: site.id, connected: false, busy: false }]));
  }

  status() {
    const now = Date.now();
    return { ...this.info, paired: !!this.pair,
      pendingPairings: [...this.pending.values()].filter(pairing => !pairing.approved && pairing.expiresAt > now).map(({ id, extensionId, createdAt }) => ({ id, extensionId, createdAt })),
      sites: [...this.sites.values()].map(site => ({ ...site, busy: site.busy || [...this.jobs.values()].some(job => job.payload.siteId === site.id) })),
    };
  }

  changed() { try { this.onChange(); } catch { /* UI subscriptions do not own the server. */ } }

  redact(value) {
    let message = String(value || 'Browser connector request failed.').slice(0, 4000);
    for (const secret of [this.apiToken, this.pair?.token, ...[...this.pending.values()].map(pairing => pairing.nonce)].filter(Boolean)) message = message.split(secret).join('[redacted]');
    return message.replace(/((?:cookie|authorization|x-api-key|api[_-]?key|session[_-]?(?:key|token)|access[_-]?token|password)["'\s:=]+)[^\r\n]+/gi, '$1[redacted]').slice(0, 1000);
  }

  async start() {
    if (this.stopPromise) throw new Error('The browser connector is stopping. Try again when it has stopped.');
    if (this.info.running) return this.status();
    if (this.startPromise) return this.startPromise;
    const controller = new AbortController(); this.startController = controller;
    this.startPromise = this.listen(controller);
    try { return await this.startPromise; }
    finally { this.startPromise = null; if (this.startController === controller) this.startController = null; }
  }

  async listen(controller) {
    const token = randomBytes(32).toString('hex'); this.apiToken = token;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch(error => {
        if (res.destroyed || res.writableEnded) return;
        if (res.headersSent) { res.destroy(); return; }
        json(res, error.status || 500, { error: { message: this.redact(error.status ? error.message : 'Browser connector request failed.'), type: 'connector_error', code: error.status || 500 } });
      });
    });
    this.server = server;
    server.requestTimeout = 30000; server.headersTimeout = 10000; server.keepAliveTimeout = 3000; server.maxHeadersCount = 40;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      server.on('error', error => { this.info.error = this.redact(error.message); this.cancelAll('Browser connector listener failed.', 503); this.changed(); });
      controller.signal.throwIfAborted();
      this.info = { running: false, url: `http://127.0.0.1:${server.address().port}/v1` };
      let abort;
      try {
        await Promise.race([
          Promise.resolve().then(() => this.onReady({ url: this.info.url, token })),
          new Promise((_, reject) => { abort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', abort, { once: true }); if (controller.signal.aborted) abort(); }),
        ]);
      } finally { controller.signal.removeEventListener('abort', abort); }
      controller.signal.throwIfAborted();
      try {
        const saved = this.store?.browserPairing?.();
        if (saved) {
          this.pair = { extensionId: saved.extensionId, token: saved.token, lastHeartbeat: Date.now() };
          // Saved trust survives restarts; runtime version/compatibility must
          // come from the worker that is actually running now.
        }
      } catch {
        this.info.error = 'The saved Chrome connection could not be restored. Connect the extension and approve it again.';
      }
      this.info.running = true;
      this.timer = setInterval(() => this.sweep(), Math.max(10, Math.min(1000, Math.floor(this.heartbeatTimeoutMs / 2), Math.floor(this.pairingTtlMs / 2))));
      this.timer.unref?.();
      this.changed(); return this.status();
    } catch (error) {
      this.info = { ...this.info, running: false, error: this.redact(controller.signal.aborted ? 'Browser connector startup was cancelled.' : error.message) };
      if (this.server === server) this.server = null;
      await new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      this.apiToken = null; this.changed(); throw new Error(this.info.error);
    }
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.startController?.abort(new Error('Browser connector stopped.'));
    this.stopPromise = Promise.resolve().then(async () => {
      if (this.startPromise) await this.startPromise.catch(() => {});
      clearInterval(this.timer); this.timer = null;
      this.cancelAll('Browser connector stopped.', 503);
      this.resetPairing();
      const server = this.server; this.server = null;
      this.info = { running: false, url: this.info.url };
      if (server) {
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      }
      this.apiToken = null; this.changed(); return this.status();
    });
    try { return await this.stopPromise; } finally { this.stopPromise = null; }
  }

  shutdown() { return this.stop(); }

  resetPairing() {
    this.pair = null; this.pending.clear(); this.cancelled.clear(); this.rateLimits.clear();
    delete this.info.extension;
    for (const site of this.sites.values()) { site.connected = false; site.busy = false; delete site.error; }
  }

  revoke() {
    this.store?.clearBrowserPairing?.();
    this.cancelAll('Chrome extension pairing was revoked.', 503);
    this.resetPairing(); delete this.info.error; this.changed(); return this.status();
  }

  approvePairing(id) {
    this.sweep();
    const pairing = this.pending.get(id);
    if (!pairing || pairing.approved) throw new Error('This pairing request expired or was already handled.');
    const token = randomBytes(32).toString('hex');
    // Persist only explicitly approved trust, encrypted with the current user's
    // OS credential store. No pending approval or website session is saved.
    this.store?.saveBrowserPairing?.({ extensionId: pairing.extensionId, token, extension: pairing.extension });
    if (this.pair) this.resetPairing();
    pairing.approved = true;
    this.pair = { extensionId: pairing.extensionId, token, lastHeartbeat: Date.now() };
    this.info.extension = { ...pairing.extension };
    for (const other of this.pending.keys()) if (other !== id) this.pending.delete(other);
    delete this.info.error; this.changed(); return this.status();
  }

  limit(key, maximum, windowMs = 60000) {
    const now = Date.now(), current = this.rateLimits.get(key);
    const limit = current && current.until > now ? current : { count: 0, until: now + windowMs };
    if (++limit.count > maximum) throw failure(429, 'Too many connector attempts. Wait before trying again.');
    this.rateLimits.set(key, limit);
  }

  sweep() {
    const now = Date.now(); let changed = false;
    for (const [id, pairing] of this.pending) if (pairing.expiresAt <= now) { this.pending.delete(id); changed = true; }
    for (const [key, limit] of this.rateLimits) if (limit.until <= now) this.rateLimits.delete(key);
    for (const [id, item] of this.cancelled) if (item.expiresAt <= now) this.cancelled.delete(id);
    if (this.pair && now - this.pair.lastHeartbeat > this.heartbeatTimeoutMs) {
      for (const site of this.sites.values()) {
        if (site.connected || site.busy) changed = true;
        site.connected = false; site.busy = false;
      }
      if (this.jobs.size) { this.cancelAll('Chrome extension disconnected. Reconnect it before sending another request.', 503); changed = true; }
      if (this.info.extension?.compatible !== false && this.info.error !== 'Chrome extension heartbeat was lost.') { this.info.error = 'Chrome extension heartbeat was lost.'; changed = true; }
    }
    if (changed) this.changed();
  }

  cancelAll(message, status) { for (const job of [...this.jobs.values()]) this.finish(job, null, failure(status, message), true); }

  finish(job, result, error, cancelled = false) {
    if (!this.jobs.delete(job.id)) return;
    clearTimeout(job.timer);
    const site = this.sites.get(job.payload.siteId); site.busy = false;
    if (error) site.error = this.redact(error.message); else delete site.error;
    if (cancelled) {
      this.cancelled.set(job.id, { expiresAt: Date.now() + 300000 });
      while (this.cancelled.size > 64) this.cancelled.delete(this.cancelled.keys().next().value);
    }
    if (error) job.reject(error); else job.resolve(result);
    this.changed();
  }

  extensionOrigin(req, res, pairing = false, fallbackId) {
    const origin = req.headers.origin;
    const match = origin === undefined ? null : EXTENSION_ORIGIN.exec(origin);
    if (origin !== undefined && !match) throw failure(403, 'Website origins are not allowed on connector endpoints.');
    const claimed = req.headers['x-connector-extension-id'] ?? fallbackId;
    if (claimed !== undefined && (typeof claimed !== 'string' || !/^[a-p]{32}$/.test(claimed))) throw failure(403, 'Invalid Chrome extension ID.');
    const extensionId = match?.[1] || claimed;
    if (!extensionId || (match && claimed && match[1] !== claimed)) throw failure(403, 'A matching Chrome extension origin or extension ID header is required.');
    if (!pairing && (!this.pair || extensionId !== this.pair.extensionId)) throw failure(403, 'This Chrome extension is not paired.');
    if (origin !== undefined) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    return extensionId;
  }

  extensionClient(req) {
    const version = req.headers['x-connector-version'];
    const protocol = req.headers['x-connector-protocol'];
    const client = {
      version: typeof version === 'string' && version.length <= 32 && /^\d+(?:\.\d+){0,3}$/.test(version) ? version : 'unknown',
      protocol: typeof protocol === 'string' && /^\d{1,4}$/.test(protocol) ? Number(protocol) : null,
      compatible: protocol === String(CONNECTOR_PROTOCOL),
    };
    if (!client.compatible) {
      client.error = EXTENSION_UPGRADE_MESSAGE;
      this.cancelAll(client.error, 503);
      for (const site of this.sites.values()) { site.connected = false; site.busy = false; }
      this.info.extension = client; this.info.error = client.error; this.changed();
      throw failure(426, client.error);
    }
    const prior = this.info.extension;
    this.info.extension = client;
    if (this.info.error === EXTENSION_UPGRADE_MESSAGE) delete this.info.error;
    if (prior?.version !== client.version || prior?.protocol !== client.protocol || !prior?.compatible) this.changed();
    return client;
  }

  async handle(req, res) {
    this.sweep();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!this.info.running || !this.server) throw failure(503, 'Browser connector is not running.');
    const server = this.server;
    const active = () => { if (!this.info.running || this.server !== server) throw failure(503, 'Browser connector was stopped.'); };
    const port = this.server.address()?.port;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) throw failure(403, 'Invalid connector host.');
    if (req.headers.cookie !== undefined) throw failure(403, 'The browser connector does not accept cookies.');
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw failure(400, 'Invalid connector path.');
    const url = new URL(req.url, this.info.url), route = url.pathname;
    if (route.startsWith('/connector/')) {
      const isPairing = route === '/connector/pair' || route === '/connector/pair/status';
      // A privileged MV3 service worker may omit Origin. Pairing still needs
      // explicit desktop approval; authenticated calls require the ID header.
      let pairBody;
      if (route === '/connector/pair' && req.method === 'POST' && req.headers.origin === undefined && req.headers['x-connector-extension-id'] === undefined) { pairBody = await bodyFor(req); active(); }
      const extensionId = this.extensionOrigin(req, res, isPairing, pairBody?.extensionId);
      if (req.method === 'OPTIONS') {
        const requested = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(header => header.trim()).filter(Boolean);
        if (requested.some(header => !['authorization', 'content-type', 'x-connector-extension-id', 'x-connector-protocol', 'x-connector-version'].includes(header))) throw failure(403, 'Unsupported connector request headers.');
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Connector-Extension-ID, X-Connector-Protocol, X-Connector-Version', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '60' }); res.end(); return;
      }
      if (isPairing) {
        this.limit('pair-total', 180);
        this.limit(`pair:${extensionId}`, route === '/connector/pair' ? 10 : 120);
        if (req.method !== 'POST') throw failure(405, 'Pairing endpoints require POST.');
        const body = pairBody || await bodyFor(req);
        active();
        if (route === '/connector/pair') {
          onlyKeys(body, ['extensionId', 'nonce']);
          if (body.extensionId !== extensionId || typeof body.nonce !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(body.nonce)) throw failure(400, 'A matching extension ID and a random nonce of 32–128 characters are required.');
          if (this.pair) throw failure(409, 'A Chrome extension is already paired. Revoke it in the desktop app before pairing again.');
          const extension = this.extensionClient(req);
          let pairing = [...this.pending.values()].find(item => item.extensionId === extensionId && equal(item.nonce, body.nonce));
          if (!pairing) {
            if (this.pending.size >= 5) throw failure(429, 'Too many pending pairing requests. Approve one or wait for them to expire.');
            const now = Date.now();
            pairing = { id: randomUUID(), extensionId, nonce: body.nonce, extension, createdAt: new Date(now).toISOString(), expiresAt: now + this.pairingTtlMs, approved: false };
            this.pending.set(pairing.id, pairing); this.changed();
          }
          json(res, 202, { id: pairing.id, expiresAt: new Date(pairing.expiresAt).toISOString() }); return;
        }
        onlyKeys(body, ['id', 'nonce']);
        const pairing = this.pending.get(body.id);
        if (!pairing || pairing.extensionId !== extensionId || !equal(pairing.nonce, body.nonce)) throw failure(404, 'Pairing request not found or expired.');
        this.extensionClient(req);
        if (!pairing.approved) { json(res, 202, { status: 'pending' }); return; }
        if (!this.pair || this.pair.extensionId !== extensionId) throw failure(404, 'Pairing request not found or expired.');
        json(res, 200, { status: 'approved', token: this.pair.token }); return;
      }
      if (!bearer(req.headers.authorization, this.pair?.token)) throw failure(401, 'A valid paired extension token is required.');
      const paired = this.pair;
      const stillPaired = () => { active(); if (this.pair !== paired) throw failure(401, 'Chrome extension pairing changed. Pair again before continuing.'); };
      this.limit('connector-total', 600, 60000);
      this.extensionClient(req);
      if (route === '/connector/jobs' && req.method === 'GET') {
        const job = [...this.jobs.values()].find(job => !job.delivered);
        if (job) job.delivered = true;
        json(res, 200, { job: job ? { id: job.id, ...job.payload } : null, cancelledJobIds: [...this.cancelled.keys()] }); return;
      }
      if (route === '/connector/heartbeat' && req.method === 'POST') {
        const body = await bodyFor(req); stillPaired(); onlyKeys(body, ['sites']);
        if (!Array.isArray(body.sites) || body.sites.length > BROWSER_SITES.length) throw failure(400, 'Heartbeat sites must be an array of the six supported site IDs.');
        const seen = new Set(), sites = body.sites.map(site => {
          if (!record(site)) throw failure(400, 'Invalid site status.');
          onlyKeys(site, ['id', 'connected', 'busy', 'error']);
          if (!SITE_IDS.has(site.id) || seen.has(site.id) || typeof site.connected !== 'boolean' || typeof site.busy !== 'boolean') throw failure(400, 'Site statuses require unique supported IDs and boolean connected/busy fields.');
          seen.add(site.id);
          return { id: site.id, connected: site.connected, busy: site.connected && site.busy, ...(site.error === undefined ? {} : { error: this.redact(text(site.error, 'Site error', 2000, true)) }) };
        });
        this.pair.lastHeartbeat = Date.now(); delete this.info.error;
        for (const id of SITE_IDS) {
          const site = sites.find(site => site.id === id) || { id, connected: false, busy: false };
          this.sites.set(id, site);
          if (!site.connected) for (const job of [...this.jobs.values()].filter(job => job.payload.siteId === id)) this.finish(job, null, failure(503, 'The selected website tab disconnected before returning a response.'), true);
        }
        this.changed(); json(res, 200, { ok: true, cancelledJobIds: [...this.cancelled.keys()] }); return;
      }
      if (route === '/connector/results' && req.method === 'POST') {
        const body = await bodyFor(req); stillPaired(); onlyKeys(body, ['id', 'siteId', 'rawText', 'result', 'error']);
        const job = this.jobs.get(body.id);
        if (!job) throw failure(404, 'Job is no longer active. Discard its result.');
        if (!job.delivered || body.siteId !== job.payload.siteId) throw failure(409, 'Result does not match a delivered job for this site.');
        if (['rawText', 'result', 'error'].filter(key => Object.hasOwn(body, key)).length !== 1) throw failure(400, 'Provide exactly one rawText, result, or error.');
        if (body.error !== undefined) {
          const message = this.redact(text(body.error, 'Website error', 2000));
          this.finish(job, null, failure(502, message)); json(res, 200, { ok: true }); return;
        }
        let result;
        try {
          // Decode website output once. Content in an already decoded reply may
          // contain quoted examples and must never be promoted into tool calls.
          const decoded = Object.hasOwn(body, 'rawText')
            ? parseSiteResult(text(body.rawText, 'Website response'), job.payload.tools, job.payload.tool_choice)
            : body.result;
          result = normalizeResult(decoded, job);
        } catch (error) {
          this.finish(job, null, failure(502, `Invalid website response: ${error.message}`));
          throw failure(error.status || 422, error.message);
        }
        this.finish(job, result); json(res, 200, { ok: true }); return;
      }
      throw failure(404, 'Unknown connector endpoint.');
    }
    if (req.headers.origin !== undefined || req.headers['x-connector-extension-id'] !== undefined) throw failure(403, 'Browser origins and extension requests are not allowed on model API endpoints.');
    if (!bearer(req.headers.authorization, this.apiToken)) throw failure(401, 'A valid desktop API bearer token is required.');
    const apiToken = this.apiToken;
    if (route === '/v1/models' && req.method === 'GET') {
      json(res, 200, { object: 'list', data: BROWSER_SITES.map(site => ({ id: site.model, object: 'model', created: 0, owned_by: 'Chrome website connector' })) }); return;
    }
    if (route !== '/v1/chat/completions' || req.method !== 'POST') throw failure(404, 'Available API endpoints: GET /v1/models and POST /v1/chat/completions.');
    const payload = normalizeCompletion(await bodyFor(req));
    active();
    if (!equal(apiToken, this.apiToken)) throw failure(401, 'Desktop API credentials changed. Retry with the current provider.');
    if (this.info.extension?.compatible === false) throw failure(503, this.info.extension.error);
    if (!this.pair) throw failure(503, 'Pair the Chrome extension in the desktop app first.');
    const site = this.sites.get(payload.siteId);
    if (!site.connected) throw failure(503, 'Open and sign in to the selected website in Chrome, then connect its tab in the extension.');
    if (site.busy || [...this.jobs.values()].some(job => job.payload.siteId === payload.siteId)) throw failure(409, 'The selected website is busy. Wait for its current request to finish.');
    if (this.jobs.size >= BROWSER_SITES.length) throw failure(429, 'The browser connector queue is full.');
    let job;
    const resultPromise = new Promise((resolve, reject) => {
      job = { id: randomUUID(), payload, delivered: false, resolve, reject };
      job.timer = setTimeout(() => this.finish(job, null, failure(504, 'The website did not return a response before the connector timeout.'), true), this.requestTimeoutMs);
      job.timer.unref?.(); this.jobs.set(job.id, job);
    });
    const cancel = () => { if (!res.writableEnded) this.finish(job, null, failure(499, 'The API client cancelled this request.'), true); };
    res.once('close', cancel);
    if (res.destroyed) cancel();
    this.changed();
    try {
      const message = await resultPromise;
      if (res.destroyed) return;
      const completion = { id: `chatcmpl-${job.id}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: payload.model,
        choices: [{ index: 0, message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }] };
      if (payload.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        const delta = { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } : {}) };
        res.end(`data: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: completion.choices[0].finish_reason }] })}\n\ndata: [DONE]\n\n`);
      } else json(res, 200, completion);
    } finally { res.removeListener('close', cancel); }
  }
}
