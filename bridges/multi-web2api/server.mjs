import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { formatJobPrompt, parseSiteResult } from './protocol.mjs';

const BODY_LIMIT = 512 * 1024;
const TEXT_LIMIT = 120000;
const OUTPUT_LIMIT = 200000;
const PROVIDERS = new Set(['qwen', 'deepseek', 'chatgpt', 'zai']);
const NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/;
const CALL_ID = /^[A-Za-z0-9_-]{1,200}$/;
const REQUEST_FIELDS = new Set(['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options', 'parallel_tool_calls', 'n', 'max_tokens', 'max_completion_tokens']);
const UNAVAILABLE_MESSAGE = 'This website provider is unavailable. Sign in again or check its connection, then restart the bridge.';

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function invalid(message) { throw new ApiError(400, 'invalid_request_error', message); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keysOnly(value, allowed, label) {
  if (!isObject(value)) invalid(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`Unsupported ${label} field: ${key}.`);
}
function boundedText(value, label, maximum = TEXT_LIMIT, empty = true) {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || (!empty && !value.trim())) {
    invalid(`${label} must be ${empty ? '' : 'nonempty '}text of at most ${maximum} characters, without NUL characters.`);
  }
  return value;
}

function boundedJson(value, depth = 0) {
  if (depth > 32) invalid('Tool schemas and arguments may be at most 32 levels deep.');
  if (typeof value === 'string') boundedText(value, 'Tool text');
  if (typeof value === 'number' && !Number.isFinite(value)) invalid('Tool numbers must be finite.');
  if (Array.isArray(value)) {
    if (value.length > 2048) invalid('Tool arrays may have at most 2,048 items.');
    for (const item of value) boundedJson(item, depth + 1);
  } else if (isObject(value)) {
    if (Object.keys(value).length > 2048) invalid('Tool objects may have at most 2,048 fields.');
    for (const [key, item] of Object.entries(value)) {
      boundedText(key, 'Tool property name', 1024);
      boundedJson(item, depth + 1);
    }
  }
}

function messageContent(content, role) {
  if (content === null && role === 'assistant') return null;
  if (typeof content === 'string') return boundedText(content, 'Message content');
  if (!Array.isArray(content) || content.length > 128) invalid('Messages support text only; images, audio, files, and attachments are unsupported.');
  const parts = content.map(part => {
    if (!isObject(part) || part.type !== 'text') invalid('Messages support text only; images, audio, files, and attachments are unsupported.');
    keysOnly(part, ['type', 'text'], 'text part');
    return boundedText(part.text, 'Message text');
  });
  return boundedText(parts.join('\n'), 'Message content');
}

function toolArguments(value) {
  boundedText(value, 'Previous tool arguments');
  let parsed;
  try { parsed = JSON.parse(value); } catch { invalid('Previous tool arguments must be a valid JSON object encoded as text.'); }
  if (!isObject(parsed)) invalid('Previous tool arguments must be a valid JSON object encoded as text.');
  boundedJson(parsed);
  return value;
}

function validateRequest(body, routes) {
  if (!isObject(body)) invalid('The request body must be a JSON object.');
  for (const key of Object.keys(body)) if (!REQUEST_FIELDS.has(key)) {
    invalid(`Unsupported request field: ${key}. Website generation controls and response formats cannot be honored by this bridge.`);
  }
  boundedText(body.model, 'model', 128, false);
  const adapter = routes.get(body.model);
  if (!adapter) throw new ApiError(404, 'model_not_found', 'This model is not configured. Query /v1/models for available model IDs.');
  if (adapter.available === false) throw new ApiError(503, 'provider_unavailable', UNAVAILABLE_MESSAGE);
  if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid('stream must be a boolean.');
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') invalid('parallel_tool_calls must be a boolean.');
  if (body.n !== undefined && body.n !== 1) invalid('Only n=1 is supported.');
  for (const field of ['max_tokens', 'max_completion_tokens']) {
    if (body[field] !== undefined && (!Number.isSafeInteger(body[field]) || body[field] < 1)) invalid(`${field} must be a positive safe integer. Website generation limits still apply.`);
  }
  if (body.stream_options !== undefined) {
    if (body.stream !== true) invalid('stream_options requires stream=true.');
    keysOnly(body.stream_options, ['include_usage'], 'stream_options');
    if (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== 'boolean') invalid('stream_options.include_usage must be a boolean.');
  }

  const tools = body.tools ?? [];
  if (!Array.isArray(tools) || tools.length > 64) invalid('tools must contain at most 64 function definitions.');
  const names = new Set();
  for (const tool of tools) {
    keysOnly(tool, ['type', 'function'], 'tool');
    if (tool.type !== 'function') invalid('Only function tools are supported.');
    keysOnly(tool.function, ['name', 'description', 'parameters', 'strict'], 'function');
    const fn = tool.function;
    if (typeof fn.name !== 'string' || !NAME.test(fn.name) || names.has(fn.name)) invalid('Function names must be valid and unique.');
    names.add(fn.name);
    if (fn.description !== undefined) boundedText(fn.description, 'Function description', 16000);
    if (fn.strict !== undefined && typeof fn.strict !== 'boolean') invalid('Function strict must be a boolean.');
    if (fn.strict === true) invalid('Strict JSON Schema enforcement is unavailable for emulated website tools.');
    if (fn.parameters !== undefined) {
      if (!isObject(fn.parameters) || (fn.parameters.type !== undefined && fn.parameters.type !== 'object')) invalid('Function parameters must be an object JSON Schema.');
      boundedJson(fn.parameters);
    }
  }
  const choice = body.tool_choice ?? (tools.length ? 'auto' : 'none');
  if (isObject(choice)) {
    keysOnly(choice, ['type', 'function'], 'tool_choice');
    keysOnly(choice.function, ['name'], 'tool_choice.function');
    if (choice.type !== 'function' || !names.has(choice.function.name)) invalid('tool_choice must name an available function.');
  } else if (!['auto', 'none', 'required'].includes(choice)) invalid('Unsupported tool_choice.');
  if (!tools.length && choice !== 'none' && choice !== 'auto') invalid('A required tool_choice needs at least one function definition.');

  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 256) invalid('messages must contain 1–256 messages.');
  const seenCalls = new Set();
  const pendingCalls = new Set();
  const messages = body.messages.map(message => {
    keysOnly(message, ['role', 'content', 'name', 'tool_calls', 'tool_call_id'], 'message');
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) invalid('Unsupported message role.');
    if (pendingCalls.size && message.role !== 'tool') invalid('Every assistant tool call must have a tool result before the conversation continues.');
    if (message.name !== undefined && (typeof message.name !== 'string' || !NAME.test(message.name))) invalid('Message name is invalid.');
    const content = message.content === undefined && message.role === 'assistant' ? null : messageContent(message.content, message.role);
    const result = { role: message.role, content };
    if (message.name !== undefined) result.name = message.name;
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length || message.tool_calls.length > 16) invalid('Only assistant messages may contain 1–16 tool_calls.');
      result.tool_calls = message.tool_calls.map(call => {
        keysOnly(call, ['id', 'type', 'function'], 'previous tool call');
        keysOnly(call.function, ['name', 'arguments'], 'previous tool function');
        if (call.type !== 'function' || typeof call.function.name !== 'string' || !NAME.test(call.function.name)) invalid('Previous tool calls must be named functions.');
        if (typeof call.id !== 'string' || !CALL_ID.test(call.id) || seenCalls.has(call.id)) invalid('Previous tool call IDs must be valid and unique.');
        seenCalls.add(call.id);
        pendingCalls.add(call.id);
        return { id: call.id, type: 'function', function: { name: call.function.name, arguments: toolArguments(call.function.arguments) } };
      });
    }
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !pendingCalls.delete(message.tool_call_id)) invalid('A tool result must match one unresolved assistant tool call.');
      result.tool_call_id = message.tool_call_id;
    } else if (message.tool_call_id !== undefined) invalid('tool_call_id is only valid on tool messages.');
    if (message.role === 'assistant' && !content?.trim() && !result.tool_calls?.length) invalid('Assistant messages must contain text or tool calls.');
    return result;
  });
  if (pendingCalls.size) invalid('Every assistant tool call needs a tool result before requesting the next completion.');
  let prompt;
  try { prompt = formatJobPrompt({ id: randomUUID(), siteId: adapter.id, messages, tools, tool_choice: choice }); }
  catch (error) { invalid(error.message); }
  return { adapter, model: body.model, prompt, tools, choice, previousCallIds: seenCalls, stream: body.stream === true, includeUsage: body.stream_options?.include_usage === true, parallelTools: body.parallel_tool_calls !== false, generationHint: body.max_tokens !== undefined || body.max_completion_tokens !== undefined };
}

function readBody(request) {
  const sizeHeader = request.headers['content-length'];
  if (sizeHeader !== undefined && (!/^\d+$/.test(sizeHeader) || Number(sizeHeader) > BODY_LIMIT)) {
    throw new ApiError(413, 'request_too_large', `Request bodies are limited to ${BODY_LIMIT} bytes.`);
  }
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] ?? '')) throw new ApiError(415, 'unsupported_media_type', 'Send Content-Type: application/json.');
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw new ApiError(415, 'unsupported_media_type', 'Compressed request bodies are unsupported.');
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAbort);
    };
    const fail = error => { cleanup(); reject(error); };
    const onData = chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        request.pause();
        fail(new ApiError(413, 'request_too_large', `Request bodies are limited to ${BODY_LIMIT} bytes.`));
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        resolve(JSON.parse(content));
      } catch { reject(new ApiError(400, 'invalid_json', 'The body must contain valid UTF-8 JSON.')); }
    };
    const onError = () => fail(new ApiError(400, 'request_aborted', 'The request body could not be read.'));
    const onAbort = () => fail(new ApiError(400, 'request_aborted', 'The request was disconnected.'));
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAbort);
  });
}

function json(response, status, value, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  response.end(JSON.stringify(value));
}

function sendError(response, error) {
  if (response.headersSent) { response.destroy(); return; }
  const safe = error instanceof ApiError ? error : new ApiError(500, 'internal_error', 'The bridge could not process this request.');
  json(response, safe.status, { error: { message: safe.message, type: safe.status < 500 ? 'invalid_request_error' : 'api_error', code: safe.code } }, { Connection: 'close', ...(safe.status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}) });
}

// Only an entire response envelope can request tools. Narrative and code
// examples stay final text, even when they mention "tool_calls". Top-level
// keys are scanned without parsing the provider response a second time.
function isResponseEnvelope(text) {
  const trimmed = text.trim();
  const fenced = /^(?:[a-zA-Z0-9_-]+\s*\n+)?```(?:json)?\s*\n?([\s\S]*?)```$/i.exec(trimmed);
  const labeled = /^[a-zA-Z0-9_-]+\s*\n+(\{[\s\S]*\})$/i.exec(trimmed);
  const body = (fenced?.[1] ?? labeled?.[1] ?? trimmed).trim();
  if (!body.startsWith('{')) return false;
  let depth = 0;
  for (let index = 0; index < body.length; index++) {
    const character = body[index];
    if (/["“”']/.test(character)) {
      if (depth === 1 && /^["“”'](?:content|tool[_ -]?calls)["“”']\s*:/i.test(body.slice(index))) return true;
      const delimiter = character;
      index++;
      while (index < body.length && body[index] !== delimiter) index += body[index] === '\\' ? 2 : 1;
    } else if (character === '{' || character === '[') depth++;
    else if (character === '}' || character === ']') depth--;
  }
  return false;
}

function validateOutput(text, request) {
  if (typeof text !== 'string' || !text.trim() || text.length > OUTPUT_LIMIT || text.includes('\0')) throw new ApiError(502, 'invalid_provider_response', 'The website returned empty, non-text, malformed, or oversized assistant output.');
  let message;
  try {
    const requireTool = request.choice === 'required' || isObject(request.choice);
    message = request.tools.length && request.choice !== 'none' && (requireTool || isResponseEnvelope(text))
      ? parseSiteResult(text, request.tools, request.choice)
      : { role: 'assistant', content: text };
    if (message.content?.includes('\0')) throw new Error('Decoded content contains NUL characters.');
    // Argument strings are checked against the same bounds as tool history.
    // The website response itself is parsed only once, above.
    const emittedIds = new Set(request.previousCallIds);
    for (const call of message.tool_calls ?? []) {
      boundedJson(JSON.parse(call.function.arguments));
      // Websites may reuse template IDs on later turns. Return a fresh local
      // correlation ID so the caller can append an unambiguous tool result.
      if (emittedIds.has(call.id)) {
        do { call.id = `web_call_${randomUUID()}`; } while (emittedIds.has(call.id));
      }
      emittedIds.add(call.id);
    }
  }
  catch { throw new ApiError(502, 'invalid_provider_response', 'The website returned an invalid assistant or tool-call response. No tool call was accepted.'); }
  if (!message.content?.trim() && !message.tool_calls?.length) throw new ApiError(502, 'invalid_provider_response', 'The website returned no usable assistant content or tool calls.');
  if (!request.parallelTools && message.tool_calls?.length > 1) throw new ApiError(502, 'invalid_provider_response', 'The website returned multiple tools while parallel_tool_calls was disabled.');
  return message;
}

function sendCompletion(response, request, message) {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const finishReason = message.tool_calls?.length ? 'tool_calls' : 'stop';
  const generationHeaders = request.generationHint ? { 'X-Web2API-Generation-Controls': 'website-defaults' } : {};
  if (!request.stream) {
    // Websites do not report authoritative token usage; do not invent counts.
    json(response, 200, { id, object: 'chat.completion', created, model: request.model, choices: [{ index: 0, message, finish_reason: finishReason }] }, generationHeaders);
    return;
  }
  // Streaming is intentionally buffered. Nothing is committed as a successful
  // SSE response until the entire website reply has passed tool validation.
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no', 'X-Web2API-Stream-Mode': 'buffered', ...generationHeaders });
  const event = (delta, finish_reason = null) => ({ id, object: 'chat.completion.chunk', created, model: request.model, choices: [{ index: 0, delta, finish_reason }], ...(request.includeUsage ? { usage: null } : {}) });
  response.write(`data: ${JSON.stringify(event({ role: 'assistant', content: '' }))}\n\n`);
  if (message.content) response.write(`data: ${JSON.stringify(event({ content: message.content }))}\n\n`);
  if (message.tool_calls?.length) response.write(`data: ${JSON.stringify(event({ tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) }))}\n\n`);
  response.write(`data: ${JSON.stringify(event({}, finishReason))}\n\n`);
  if (request.includeUsage) response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: request.model, choices: [], usage: null })}\n\n`);
  response.end('data: [DONE]\n\n');
}

/**
 * A local, authenticated OpenAI Chat Completions facade. Adapter.complete must
 * honor signal and return the complete website response as text. Only the
 * configured adapters and their exact public model IDs are exposed.
 */
export function createWebApiServer({ adapters, apiToken, host = '127.0.0.1', port = 4320, timeoutMs = 180000 } = {}) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Web2API must bind a literal loopback address or localhost.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Web2API port must be an integer from 0 to 65535.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000) throw new Error('Web2API timeoutMs must be from 1 to 1,800,000 milliseconds.');
  if (typeof apiToken !== 'string' || apiToken.length < 16 || apiToken.length > 512 || /\s/.test(apiToken)) throw new Error('Web2API apiToken must contain 16–512 non-whitespace characters.');
  if (!Array.isArray(adapters) || adapters.length > 4) throw new Error('Web2API adapters must be an array with at most four providers.');
  const routes = new Map();
  const providers = [];
  for (const adapter of adapters) {
    if (!adapter || !PROVIDERS.has(adapter.id) || providers.some(provider => provider.id === adapter.id) || typeof adapter.complete !== 'function') throw new Error('Web2API adapters require a unique supported provider ID and complete function.');
    if (typeof adapter.label !== 'string' || !adapter.label.trim() || adapter.label.length > 128) throw new Error('Web2API adapters require a short label.');
    if (!Array.isArray(adapter.models) || !adapter.models.length || adapter.models.length > 32) throw new Error('Each Web2API provider must expose 1–32 models.');
    const models = adapter.models.map(model => {
      if (!model || typeof model.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model.id) || routes.has(model.id)) throw new Error('Public model IDs must be valid and globally unique.');
      routes.set(model.id, adapter);
      return model.id;
    });
    providers.push({ id: adapter.id, label: adapter.label, models: adapter.available === false ? [] : models,
      ...(adapter.available === false ? { available: false, error: { code: 'provider_unavailable', message: UNAVAILABLE_MESSAGE } } : {}) });
  }
  const tokenHash = createHash('sha256').update(apiToken).digest();
  const active = new Map();
  const releasingProfiles = new Set();
  const connections = new Set();
  let address;
  let startPromise;
  let stopPromise;
  let stopping = false;

  const server = http.createServer({ maxHeaderSize: 16384 }, async (incoming, response) => {
    try {
      if (stopping) throw new ApiError(503, 'server_stopping', 'The bridge is stopping.');
      if (incoming.rawHeaders.length > 64) throw new ApiError(431, 'request_headers_too_large', 'Requests are limited to 32 headers.');
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(incoming.socket.remoteAddress)) throw new ApiError(403, 'loopback_required', 'Only local loopback clients are accepted.');
      if (incoming.headers.origin !== undefined || incoming.headers.cookie !== undefined) throw new ApiError(403, 'browser_request_forbidden', 'Browser Origin and Cookie requests are not accepted by this local API.');
      const requestHost = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/i.exec(incoming.headers.host ?? '');
      if (!requestHost || Number(requestHost[2] ?? 80) !== address?.port) throw new ApiError(403, 'invalid_host', 'The Host header must address this local loopback server.');
      if (incoming.method === 'GET' && incoming.url === '/health') { json(response, 200, { status: 'ok' }); return; }
      const authorization = incoming.headers.authorization ?? '';
      const matches = /^Bearer ([^\s]+)$/i.exec(authorization);
      const supplied = createHash('sha256').update(matches?.[1] ?? '').digest();
      if (!matches || !timingSafeEqual(tokenHash, supplied)) throw new ApiError(401, 'unauthorized', 'A valid local Bearer token is required.');
      if (incoming.method === 'GET' && incoming.url === '/v1/models') {
        json(response, 200, { object: 'list', data: providers.flatMap(provider => provider.models.map(id => ({ id, object: 'model', created: 0, owned_by: provider.id }))) });
        return;
      }
      if (incoming.method === 'GET' && incoming.url === '/status') {
        json(response, 200, { status: 'ok', streaming: 'buffered', providers: providers.map(provider => ({ ...provider,
          busy: active.has(provider.id) || releasingProfiles.has(provider.id),
          browserProfileOpen: !!adapters.find(adapter => adapter.id === provider.id)?.profileStatus?.().browserProfileOpen })) });
        return;
      }
      const closeProfile = /^\/profiles\/(chatgpt|zai|qwen|deepseek)\/close$/.exec(incoming.url || '');
      if (incoming.method === 'POST' && closeProfile) {
        const siteId = closeProfile[1], adapter = adapters.find(item => item.id === siteId);
        if (!adapter) throw new ApiError(404, 'profile_not_loaded', 'This website is not loaded by the running service.');
        if (active.has(siteId) || releasingProfiles.has(siteId)) throw new ApiError(409, 'provider_busy', 'This account is in use. Wait for its request to finish before signing in again.');
        if (incoming.headers['transfer-encoding'] || (incoming.headers['content-length'] && incoming.headers['content-length'] !== '0')) throw new ApiError(400, 'unexpected_body', 'Profile release does not accept a request body.');
        releasingProfiles.add(siteId);
        try { await adapter.close?.(); json(response, 200, { siteId, released: true }); }
        finally { releasingProfiles.delete(siteId); }
        return;
      }
      if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions') throw new ApiError(404, 'not_found', 'Unknown endpoint. Use /v1/models or /v1/chat/completions.');
      const request = validateRequest(await readBody(incoming), routes);
      if (stopping) throw new ApiError(503, 'server_stopping', 'The bridge is stopping.');
      if (active.has(request.adapter.id) || releasingProfiles.has(request.adapter.id)) throw new ApiError(409, 'provider_busy', 'This provider already has an active request. Retry after it completes.');
      const controller = new AbortController();
      const disconnected = () => { if (!response.writableEnded) controller.abort(new ApiError(499, 'client_disconnected', 'The client disconnected.')); };
      response.once('close', disconnected);
      if (response.destroyed) { response.off('close', disconnected); return; }
      const timer = setTimeout(() => controller.abort(new ApiError(504, 'provider_timeout', 'The website did not complete before the request timeout.')), timeoutMs);
      timer.unref?.();
      active.set(request.adapter.id, controller);
      const operation = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return request.adapter.complete({ model: request.model, prompt: request.prompt }, { signal: controller.signal });
      });
      const release = () => { if (active.get(request.adapter.id) === controller) active.delete(request.adapter.id); };
      // Keep the provider busy until the underlying operation settles, even if
      // an adapter neglects cancellation. Two browser jobs must never overlap.
      operation.then(release, release);
      let onAbort;
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      try {
        let text;
        try { text = await Promise.race([operation, aborted]); }
        catch (error) {
          if (error instanceof ApiError) throw error;
          // Upstream errors can contain URLs, cookies, or session tokens.
          throw new ApiError(502, 'provider_error', 'The website request failed. Check the provider session and try again.');
        }
        if (!controller.signal.aborted && !response.destroyed) sendCompletion(response, request, validateOutput(text, request));
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
        response.off('close', disconnected);
      }
    } catch (error) { sendError(response, error); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  // Older Node versions truncate header pairs at this limit; newer versions
  // reject them in the parser. Both paths must return the same bounded error.
  server.maxHeadersCount = 33;
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 128;
  server.on('connection', socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  server.on('clientError', (error, socket) => {
    if (!socket.writable) return;
    if (error.code === 'HPE_HEADER_OVERFLOW') {
      const body = JSON.stringify({ error: { message: 'Request headers exceed the supported count or size.', type: 'invalid_request_error', code: 'request_headers_too_large' } });
      socket.end(`HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    } else socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });

  return {
    start() {
      if (stopping) return Promise.reject(new Error('A stopped Web2API server cannot be restarted.'));
      if (!startPromise) startPromise = new Promise((resolve, reject) => {
        const failed = error => { server.off('listening', listening); reject(error); };
        const listening = () => {
          server.off('error', failed);
          const bound = server.address();
          address = { host: bound.address, port: bound.port, url: `http://${bound.family === 'IPv6' ? `[${bound.address}]` : bound.address}:${bound.port}` };
          resolve({ ...address });
        };
        server.once('error', failed);
        server.once('listening', listening);
        server.listen(port, host === 'localhost' ? '127.0.0.1' : host);
      });
      return startPromise;
    },
    stop() {
      if (!stopPromise) stopPromise = (async () => {
        stopping = true;
        for (const controller of active.values()) controller.abort(new ApiError(503, 'server_stopping', 'The bridge is stopping.'));
        if (!startPromise) return;
        try { await startPromise; } catch { return; }
        await new Promise(resolve => {
          server.close(() => resolve());
          server.closeIdleConnections?.();
          // Give active handlers a turn to deliver their cancellation errors,
          // then close incomplete uploads and clients that remain connected.
          setImmediate(() => { for (const socket of connections) socket.destroy(); });
        });
      })();
      return stopPromise;
    }
  };
}
