import { randomUUID } from 'node:crypto';

// Providers are main-process objects. Never send their apiKey or headers to a web view.
export class ProviderError extends Error {
  constructor(message, status = 502, code = 'provider_error') {
    super(message); this.name = 'ProviderError'; this.status = status; this.code = code;
  }
}

const DEFAULT_TIMEOUT = 180_000;
const MAX_EVENT = 8 * 1024 * 1024;
const TYPES = new Set(['openai', 'anthropic', 'gemini']);
const own = (o, key) => Object.prototype.hasOwnProperty.call(o, key);

function providerType(provider) {
  const type = provider.type || 'openai';
  if (!TYPES.has(type)) throw new ProviderError(`Unsupported provider type: ${type}`, 400);
  return type;
}

function endpoint(provider, path = '') {
  const type = providerType(provider);
  let url;
  try { url = new URL(provider.baseUrl); } catch { throw new ProviderError('Enter an absolute API base URL.', 400); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ProviderError('API base URLs must use HTTP or HTTPS without embedded credentials.', 400);
  }
  url.hash = '';
  let base = url.pathname.replace(/\/+$/, '');
  if (type === 'openai') base = base.replace(/\/(?:chat\/completions|models)$/, '');
  if (type === 'anthropic') base = base.replace(/\/(?:messages|models)$/, '') || '/v1';
  if (type === 'gemini') base = base.replace(/\/models(?:\/[^/]+:(?:streamGenerateContent|generateContent))?$/, '') || '/v1beta';
  url.pathname = `${base}/${path.replace(/^\/+/, '')}`;
  return url;
}

function headersFor(provider) {
  const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json' });
  const type = providerType(provider);
  if (type === 'anthropic') headers.set('anthropic-version', '2023-06-01');
  if (provider.apiKey) {
    headers.set(type === 'anthropic' ? 'x-api-key' : type === 'gemini' ? 'x-goog-api-key' : 'authorization',
      type === 'openai' ? `Bearer ${provider.apiKey}` : provider.apiKey);
  }
  for (const [name, value] of Object.entries(provider.headers || {})) {
    if (value != null && !['host', 'content-length', 'connection', 'cookie'].includes(name.toLowerCase())) headers.set(name, String(value));
  }
  return headers;
}

function scopeFor(signal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason || new DOMException('Request cancelled', 'AbortError'));
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Provider request timed out', 'TimeoutError')), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, close() { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}

function redact(message, provider) {
  let text = String(message || 'Provider request failed');
  for (const secret of [provider.apiKey, ...Object.values(provider.headers || {})]) {
    if (typeof secret === 'string' && secret.length > 3) text = text.split(secret).join('[redacted]');
  }
  return text.slice(0, 1800);
}

function upstreamError(payload, provider, status = 502) {
  const detail = payload?.error?.message || payload?.error?.detail || payload?.error || payload?.message || 'The provider returned an error.';
  return new ProviderError(redact(typeof detail === 'string' ? detail : JSON.stringify(detail), provider), status, payload?.error?.code || 'upstream_error');
}

async function request(provider, url, body, scope) {
  let response;
  try {
    response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: headersFor(provider),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: scope.signal, redirect: 'error' });
  } catch (error) {
    if (scope.signal.aborted) throw scope.signal.reason;
    const networkCode = error.cause?.code || error.cause?.errors?.find(e => e.code)?.code;
    if (networkCode === 'ECONNREFUSED') {
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      throw new ProviderError(local
        ? `Nothing is accepting connections at ${url.origin}. Start the matching Web2API bridge, or correct the Base URL and port. Saving a provider does not start a server.`
        : `Connection refused by ${url.origin}. Check that the API server is running and its Base URL and port are correct.`, 502, 'connection_refused');
    }
    if (networkCode === 'ENOTFOUND' || networkCode === 'EAI_AGAIN') throw new ProviderError(`Cannot resolve API host ${url.hostname}. Check the Base URL and network connection.`, 502, 'dns_error');
    throw new ProviderError(`Cannot reach provider: ${redact(error.message, provider)}`, 502, 'connection_error');
  }
  if (!response.ok) {
    const raw = await response.text();
    let payload; try { payload = JSON.parse(raw); } catch { payload = { message: raw || response.statusText }; }
    throw upstreamError(payload, provider, response.status);
  }
  return response;
}

async function jsonResponse(response, provider) {
  let data;
  try { data = await response.json(); } catch { throw new ProviderError('Provider returned invalid JSON.', 502, 'invalid_response'); }
  if (data?.error) throw upstreamError(data, provider);
  return data;
}

// SSE is line-oriented; CRLF and a multibyte character can both straddle network chunks.
async function* readSSE(response) {
  if (!response.body) throw new ProviderError('Provider returned an empty stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', data = [], event = '', dataSize = 0;
  function parseLine(line) {
    if (!line) {
      if (!data.length) { event = ''; return null; }
      const result = { event, data: data.join('\n') }; data = []; event = ''; dataSize = 0; return result;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const key = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (key === 'data') { data.push(value); dataSize += value.length; }
    if (key === 'event') event = value;
    if (dataSize > MAX_EVENT) throw new ProviderError('Provider SSE event exceeded the size limit.');
    return null;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let position = 0;
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch !== '\r' && ch !== '\n') continue;
        if (ch === '\r' && i === buffer.length - 1 && !done) break;
        const entry = parseLine(buffer.slice(position, i));
        if (entry) yield entry;
        if (ch === '\r' && buffer[i + 1] === '\n') i++;
        position = i + 1;
      }
      buffer = buffer.slice(position);
      if (buffer.length > MAX_EVENT) throw new ProviderError('Provider SSE line exceeded the size limit.');
      if (done) {
        if (buffer) { const entry = parseLine(buffer); if (entry) yield entry; }
        const entry = parseLine(''); if (entry) yield entry;
        break;
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function parseEvent(entry, provider) {
  let value;
  try { value = JSON.parse(entry.data); } catch { throw new ProviderError('Provider sent malformed JSON in an SSE event.', 502, 'invalid_stream'); }
  if (entry.event === 'error' || value.error || value.type === 'error') throw upstreamError(value, provider);
  return value;
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(p => ['text', 'input_text', 'output_text'].includes(p.type)).map(p => p.text || '').join('\n');
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch { throw new ProviderError('A tool call contains invalid JSON arguments.', 400); }
}

function anthropicParts(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return (Array.isArray(content) ? content : []).flatMap(part => {
    if (['text', 'input_text', 'output_text'].includes(part.type)) return [{ type: 'text', text: part.text || '' }];
    if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      const match = /^data:([^;]+);base64,(.+)$/s.exec(url || '');
      return [{ type: 'image', source: match ? { type: 'base64', media_type: match[1], data: match[2] } : { type: 'url', url } }];
    }
    throw new ProviderError(`Unsupported Anthropic content type: ${part.type}`, 400);
  });
}

function toAnthropic(body, stream) {
  const messages = [], system = [];
  for (const message of body.messages || []) {
    if (['system', 'developer'].includes(message.role)) { system.push(...anthropicParts(message.content)); continue; }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = message.role === 'tool'
      ? [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: textContent(message.content) }]
      : anthropicParts(message.content);
    for (const call of message.tool_calls || []) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) });
    if (!content.length) continue;
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content); else messages.push({ role, content });
  }
  const result = { model: body.model, messages, max_tokens: body.max_completion_tokens ?? body.max_tokens ?? 4096, stream };
  if (system.length) result.system = system;
  if (body.temperature != null) result.temperature = body.temperature;
  if (body.top_p != null) result.top_p = body.top_p;
  if (body.stop) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.tools?.length && body.tool_choice !== 'none') {
    result.tools = body.tools.map(tool => ({ name: tool.function.name, description: tool.function.description || '', input_schema: tool.function.parameters || { type: 'object', properties: {} } }));
    result.tool_choice = typeof body.tool_choice === 'object' ? { type: 'tool', name: body.tool_choice.function.name }
      : { type: body.tool_choice === 'required' ? 'any' : 'auto' };
    if (body.parallel_tool_calls === false) result.tool_choice.disable_parallel_tool_use = true;
  }
  return result;
}

function geminiParts(content) {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  return (Array.isArray(content) ? content : []).flatMap(part => {
    if (['text', 'input_text', 'output_text'].includes(part.type)) return [{ text: part.text || '' }];
    if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      const match = /^data:([^;]+);base64,(.+)$/s.exec(url || '');
      if (match) return [{ inlineData: { mimeType: match[1], data: match[2] } }];
      throw new ProviderError('Native Gemini image inputs require a base64 data URL.', 400);
    }
    throw new ProviderError(`Unsupported Gemini content type: ${part.type}`, 400);
  });
}

function toGemini(body) {
  const contents = [], system = [], callNames = new Map();
  for (const message of body.messages || []) {
    if (['system', 'developer'].includes(message.role)) { system.push(...geminiParts(message.content)); continue; }
    const role = message.role === 'assistant' ? 'model' : 'user';
    let parts;
    if (message.role === 'tool') {
      const name = callNames.get(message.tool_call_id) || message.name;
      if (!name) throw new ProviderError('Gemini tool result is missing its original function name.', 400);
      const text = textContent(message.content);
      let response; try { response = JSON.parse(text); } catch { response = { result: text }; }
      if (!response || typeof response !== 'object' || Array.isArray(response)) response = { result: response };
      parts = [{ functionResponse: { name, response } }];
    } else parts = geminiParts(message.content);
    for (const call of message.tool_calls || []) {
      callNames.set(call.id, call.function.name);
      parts.push({ functionCall: { name: call.function.name, args: parseArguments(call.function.arguments) },
        ...(call.thought_signature ? { thoughtSignature: call.thought_signature } : {}) });
    }
    if (!parts.length) continue;
    const previous = contents.at(-1);
    if (previous?.role === role) previous.parts.push(...parts); else contents.push({ role, parts });
  }
  const result = { contents };
  if (system.length) result.systemInstruction = { parts: system };
  const config = {};
  for (const [input, output] of [['temperature', 'temperature'], ['top_p', 'topP'], ['max_tokens', 'maxOutputTokens'], ['max_completion_tokens', 'maxOutputTokens']]) {
    if (body[input] != null) config[output] = body[input];
  }
  if (body.stop) config.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.response_format?.type === 'json_object') config.responseMimeType = 'application/json';
  if (Object.keys(config).length) result.generationConfig = config;
  if (body.tools?.length) {
    result.tools = [{ functionDeclarations: body.tools.map(tool => ({ name: tool.function.name, description: tool.function.description || '', parametersJsonSchema: tool.function.parameters || { type: 'object', properties: {} } })) }];
    const choice = body.tool_choice;
    result.toolConfig = { functionCallingConfig: {
      mode: choice === 'none' ? 'NONE' : choice === 'required' || typeof choice === 'object' ? 'ANY' : 'AUTO',
      ...(typeof choice === 'object' ? { allowedFunctionNames: [choice.function.name] } : {})
    } };
  }
  return result;
}

function finishReason(reason) {
  if (['tool_use', 'tool_calls'].includes(reason)) return 'tool_calls';
  if (['max_tokens', 'MAX_TOKENS', 'length'].includes(reason)) return 'length';
  if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'content_filter'].includes(reason)) return 'content_filter';
  return 'stop';
}

function usageFor(data, type) {
  if (!data) return undefined;
  if (type === 'openai') return data;
  const prompt = type === 'anthropic' ? data.input_tokens : data.promptTokenCount;
  const output = type === 'anthropic' ? data.output_tokens : data.candidatesTokenCount;
  return { ...(prompt == null ? {} : { prompt_tokens: prompt }), ...(output == null ? {} : { completion_tokens: output }),
    ...(type === 'gemini' && data.totalTokenCount != null ? { total_tokens: data.totalTokenCount }
      : prompt != null && output != null ? { total_tokens: prompt + output } : {}) };
}

function makeCompletion(model, message, finish, extras = {}) {
  return { id: `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message, finish_reason: finish }], ...extras };
}

function normalize(data, type, model) {
  if (type === 'openai') {
    if (!Array.isArray(data.choices) || !data.choices.length || !data.choices[0].message) throw new ProviderError('Provider returned no chat completion choices.', 502, 'invalid_response');
    return { ...data, object: 'chat.completion' };
  }
  let content = '', reasoning = '', calls = [], finish = 'stop';
  if (type === 'anthropic') {
    if (!Array.isArray(data.content)) throw new ProviderError('Anthropic returned no message content.');
    for (const part of data.content) {
      if (part.type === 'text') content += part.text || '';
      if (part.type === 'thinking') reasoning += part.thinking || '';
      if (part.type === 'tool_use') calls.push({ id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input || {}) } });
    }
    finish = finishReason(data.stop_reason);
  } else {
    if (!data.candidates?.length) throw new ProviderError(`Gemini returned no candidates${data.promptFeedback?.blockReason ? `: ${data.promptFeedback.blockReason}` : '.'}`);
    const candidate = data.candidates[0];
    for (const part of candidate.content?.parts || []) {
      if (part.text) { if (part.thought) reasoning += part.text; else content += part.text; }
      if (part.functionCall) calls.push({ id: part.functionCall.id || `call_${randomUUID()}`, type: 'function', function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) },
        ...(part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {}) });
    }
    finish = finishReason(candidate.finishReason);
  }
  const message = { role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}) };
  const usage = usageFor(type === 'anthropic' ? data.usage : data.usageMetadata, type);
  return makeCompletion(data.model || data.modelVersion || model, message, calls.length ? 'tool_calls' : finish, {
    ...(data.id ? { id: data.id } : {}), ...(usage ? { usage } : {})
  });
}

function completionUrl(provider, model, stream) {
  const type = providerType(provider);
  if (type === 'anthropic') return endpoint(provider, 'messages');
  if (type === 'gemini') {
    const encodedModel = encodeURIComponent(String(model).replace(/^models\//, ''));
    const url = endpoint(provider, `models/${encodedModel}:${stream ? 'streamGenerateContent' : 'generateContent'}`);
    if (stream) url.searchParams.set('alt', 'sse');
    return url;
  }
  return endpoint(provider, 'chat/completions');
}

export function safeGenerationEndpoint(provider, model) {
  const url = completionUrl(provider, model, false);
  url.search = '';
  return redact(url.href, provider);
}

function requestBody(provider, body, stream) {
  const type = providerType(provider);
  if (!body?.model || !Array.isArray(body.messages) || !body.messages.length) throw new ProviderError('A model and at least one message are required.', 400);
  return { url: completionUrl(provider, body.model, stream),
    payload: type === 'anthropic' ? toAnthropic(body, stream) : type === 'gemini' ? toGemini(body) : { ...body, stream } };
}

export async function discoverModels(provider, { signal, timeoutMs = 30_000 } = {}) {
  const scope = scopeFor(signal, timeoutMs), type = providerType(provider), models = new Set();
  let next;
  try {
    for (let page = 0; page < 20; page++) {
      const url = endpoint(provider, 'models');
      if (next) url.searchParams.set(type === 'gemini' ? 'pageToken' : 'after_id', next);
      const data = await jsonResponse(await request(provider, url, undefined, scope), provider);
      const list = type === 'gemini' ? data.models : data.data;
      if (!Array.isArray(list)) throw new ProviderError('The models endpoint returned an unexpected response.', 502, 'invalid_response');
      for (const model of list) {
        if (type === 'gemini' && model.supportedGenerationMethods?.length && !model.supportedGenerationMethods.some(method => ['generateContent', 'streamGenerateContent'].includes(method))) continue;
        const id = type === 'gemini' ? model.name?.replace(/^models\//, '') : model.id;
        if (typeof id === 'string' && id) models.add(id);
      }
      const token = type === 'gemini' ? data.nextPageToken : type === 'anthropic' && data.has_more ? data.last_id : undefined;
      if (!token || token === next) return [...models].sort();
      next = token;
    }
    throw new ProviderError('Model discovery exceeded 20 pages.');
  } catch (error) {
    if (scope.signal.aborted) throw scope.signal.reason;
    throw error;
  } finally { scope.close(); }
}

export async function complete(provider, body, { signal, onDelta, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  if (onDelta || body.stream) {
    let result, usage;
    const choices = new Map();
    for await (const chunk of streamCompletion(provider, body, { signal, timeoutMs })) {
      if (!result) result = { id: chunk.id, object: 'chat.completion', created: chunk.created, model: chunk.model, choices: [] };
      if (chunk.usage) usage = { ...usage, ...chunk.usage };
      for (const incoming of chunk.choices || []) {
        const index = incoming.index ?? 0;
        let choice = choices.get(index);
        if (!choice) { choice = { index, message: { role: 'assistant', content: '' }, finish_reason: null, calls: new Map() }; choices.set(index, choice); }
        const delta = incoming.delta || {};
        if (delta.content) { choice.message.content += delta.content; if (index === 0) await onDelta?.(delta.content); }
        if (delta.reasoning_content) choice.message.reasoning_content = (choice.message.reasoning_content || '') + delta.reasoning_content;
        if (incoming.finish_reason != null) choice.finish_reason = incoming.finish_reason;
        for (const [offset, change] of (delta.tool_calls || []).entries()) {
          const callIndex = change.index ?? offset;
          let call = choice.calls.get(callIndex);
          if (!call) { call = { id: change.id || `call_${randomUUID()}`, type: 'function', function: { name: '', arguments: '' } }; choice.calls.set(callIndex, call); }
          if (change.id) call.id = change.id;
          if (change.function?.name) call.function.name += change.function.name;
          if (change.function?.arguments) call.function.arguments += change.function.arguments;
          if (change.thought_signature) call.thought_signature = change.thought_signature;
        }
      }
    }
    if (!result || !choices.size) throw new ProviderError('Provider returned an empty completion stream.');
    result.choices = [...choices.values()].sort((a, b) => a.index - b.index).map(({ calls, ...choice }) => {
      if (calls.size) choice.message.tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => {
        if (!call.function.arguments) call.function.arguments = '{}'; return call;
      });
      if (!choice.message.content) choice.message.content = null;
      return choice;
    });
    if (usage) result.usage = usage;
    return result;
  }
  const scope = scopeFor(signal, timeoutMs);
  try {
    const { url, payload } = requestBody(provider, body, false);
    const response = await request(provider, url, payload, scope);
    return normalize(await jsonResponse(response, provider), providerType(provider), body.model);
  } catch (error) {
    if (scope.signal.aborted) throw scope.signal.reason;
    throw error;
  } finally { scope.close(); }
}

export async function* streamCompletion(provider, body, { signal, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const scope = scopeFor(signal, timeoutMs), type = providerType(provider);
  let id = `chatcmpl-${randomUUID()}`, model = body.model, done = false, sawChoice = false;
  const created = Math.floor(Date.now() / 1000), toolIndexes = new Map();
  let toolCount = 0, nativeUsage = {};
  const chunk = (delta, finish = null, index = 0, usage) => ({ id, object: 'chat.completion.chunk', created, model,
    choices: [{ index, delta, finish_reason: finish }], ...(usage ? { usage } : {}) });
  try {
    const { url, payload } = requestBody(provider, body, true);
    const response = await request(provider, url, payload, scope);
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const result = normalize(await jsonResponse(response, provider), type, body.model);
      yield { ...result, object: 'chat.completion.chunk', choices: result.choices.map(choice => ({ index: choice.index, delta: choice.message, finish_reason: choice.finish_reason })) };
      return;
    }
    for await (const entry of readSSE(response)) {
      if (entry.data.trim() === '[DONE]') { done = true; break; }
      const data = parseEvent(entry, provider);
      if (type === 'openai') {
        if (!Array.isArray(data.choices)) throw new ProviderError('Provider stream event is missing choices.', 502, 'invalid_stream');
        if (data.choices.length) sawChoice = true;
        if (data.choices.some(choice => choice.finish_reason != null)) done = true;
        yield { id, object: 'chat.completion.chunk', created, model, ...data };
      } else if (type === 'anthropic') {
        const kind = data.type || entry.event;
        if (kind === 'message_start') {
          id = data.message.id || id; model = data.message.model || model;
          nativeUsage = { ...nativeUsage, ...data.message.usage }; sawChoice = true;
          yield chunk({ role: 'assistant' }, null, 0, usageFor(nativeUsage, type));
        } else if (kind === 'content_block_start') {
          const block = data.content_block;
          if (block.type === 'text' && block.text) yield chunk({ content: block.text });
          if (block.type === 'tool_use') {
            const tool = { index: toolCount++, hasArguments: !!Object.keys(block.input || {}).length };
            toolIndexes.set(data.index, tool);
            yield chunk({ tool_calls: [{ index: tool.index, id: block.id, type: 'function', function: { name: block.name, arguments: tool.hasArguments ? JSON.stringify(block.input) : '' } }] });
          }
        } else if (kind === 'content_block_delta') {
          if (data.delta.type === 'text_delta') yield chunk({ content: data.delta.text });
          if (data.delta.type === 'thinking_delta') yield chunk({ reasoning_content: data.delta.thinking });
          if (data.delta.type === 'input_json_delta') {
            const tool = toolIndexes.get(data.index);
            if (!tool) throw new ProviderError('Anthropic stream referenced an unknown tool block.');
            tool.hasArguments = true;
            yield chunk({ tool_calls: [{ index: tool.index, function: { arguments: data.delta.partial_json } }] });
          }
        } else if (kind === 'content_block_stop') {
          const tool = toolIndexes.get(data.index);
          if (tool && !tool.hasArguments) yield chunk({ tool_calls: [{ index: tool.index, function: { arguments: '{}' } }] });
        } else if (kind === 'message_delta') {
          nativeUsage = { ...nativeUsage, ...data.usage };
          if (data.delta.stop_reason) done = true;
          yield chunk({}, data.delta.stop_reason ? finishReason(data.delta.stop_reason) : null, 0, usageFor(nativeUsage, type));
        } else if (kind === 'message_stop') { done = true; break; }
      } else {
        if (data.promptFeedback?.blockReason) throw new ProviderError(`Gemini blocked the prompt: ${data.promptFeedback.blockReason}`);
        if (data.modelVersion) model = data.modelVersion;
        if (data.usageMetadata) nativeUsage = { ...nativeUsage, ...data.usageMetadata };
        if (!data.candidates?.length && data.usageMetadata && sawChoice) {
          yield { id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageFor(nativeUsage, type) };
        }
        for (const candidate of data.candidates || []) {
          const delta = sawChoice ? {} : { role: 'assistant' }, index = candidate.index ?? 0;
          sawChoice = true;
          for (const part of candidate.content?.parts || []) {
            if (part.text) { const key = part.thought ? 'reasoning_content' : 'content'; delta[key] = (delta[key] || '') + part.text; }
            if (part.functionCall) {
              delta.tool_calls ||= [];
              delta.tool_calls.push({ index: toolCount++, id: part.functionCall.id || `call_${randomUUID()}`, type: 'function',
                function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) },
                ...(part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {}) });
            }
          }
          if (candidate.finishReason) done = true;
          yield chunk(delta, candidate.finishReason ? (toolCount ? 'tool_calls' : finishReason(candidate.finishReason)) : null, index, usageFor(nativeUsage, type));
        }
      }
    }
    if (!sawChoice) throw new ProviderError('Provider returned an empty completion stream.', 502, 'invalid_stream');
    if (!done) throw new ProviderError('Provider stream ended before a completion marker. Retry the request.', 502, 'incomplete_stream');
  } catch (error) {
    if (scope.signal.aborted) throw scope.signal.reason;
    throw error;
  } finally { scope.close(); }
}
