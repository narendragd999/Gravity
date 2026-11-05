// Protocol adapted from MIT FreeTokenAPI a54a9bb5; see vendor/README.md.
import { randomUUID } from 'node:crypto';
import { adapterError, readJson, readSse, requestSignal, requireToken, send } from './direct-http.mjs';
import { proofHeader, solveDeepSeekChallenge, validateChallenge } from './deepseek-pow.mjs';

const BASE = 'https://chat.deepseek.com';
const MODELS = [{ id: 'deepseek-web', name: 'DeepSeek Web' }, { id: 'deepseek-web-thinking', name: 'DeepSeek Web Thinking' }];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, detail, status = 502) => adapterError('DeepSeek', status, code, detail);

function businessData(payload) {
  if (!object(payload) || !Number.isInteger(payload.code)) throw fail('invalid_response', 'the website returned an invalid response envelope.');
  const code = payload.code || payload.data?.biz_code;
  if (code) {
    // Upstream messages can contain account or prompt data; report fixed text only.
    if ([401, 403, 40001, 40002, 40003, 40012, 40029].includes(code)) throw fail('authentication_required', 'the web session expired or lacks access; sign in again.', 401);
    if (code === 429) throw fail('rate_limited', 'the website rate limit was reached; try again later.', 429);
    throw fail('upstream_error', 'the website rejected the request or reported a generation error.');
  }
  if (!object(payload.data) || !object(payload.data.biz_data)) throw fail('invalid_response', 'the website returned an invalid data envelope.');
  return payload.data.biz_data;
}

function accountModels(data) {
  const configs = data.settings?.model_configs?.value;
  if (!Array.isArray(configs) || configs.some(entry => !object(entry))) throw fail('invalid_response', 'model discovery returned invalid account capabilities.');
  const defaults = configs.filter(entry => entry.model_type === 'default');
  if (defaults.length > 1) throw fail('invalid_response', 'model discovery returned duplicate default entries.');
  const entry = defaults[0];
  if (!entry || entry.enabled !== true || entry.switchable !== true) throw fail('model_unavailable', 'this account did not advertise an available chat model.', 503);
  if (entry.think_feature !== undefined && entry.think_feature !== null && !object(entry.think_feature)) throw fail('invalid_response', 'model discovery returned invalid thinking capabilities.');
  return MODELS.filter((_, index) => !index || object(entry.think_feature)).map(model => ({ ...model, upstream_model: 'default' }));
}

function arrayIndex(key, length, append = false) {
  if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length + Number(append)) throw fail('invalid_response', 'the website returned an invalid array delta index.');
  return Number(key);
}

// Reconstruct snapshots and remembered delta paths, avoiding duplicated text.
export class DeepSeekStream {
  constructor() { this.message = {}; this.path = ''; this.op = 'SET'; this.messageId = null; this.done = false; }
  apply(op, path, value, depth = 0) {
    if (depth > 24 || typeof path !== 'string' || path.length > 1024 || !['SET', 'APPEND', 'BATCH'].includes(op)) throw fail('invalid_response', 'the website returned an invalid delta.');
    if (op === 'BATCH') {
      if (!Array.isArray(value) || value.length > 1024) throw fail('invalid_response', 'the website returned an invalid delta batch.');
      for (const sub of value) {
        if (!object(sub)) throw fail('invalid_response', 'the website returned an invalid delta batch.');
        let subPath = sub.p ?? '';
        if (typeof subPath !== 'string') throw fail('invalid_response', 'the website returned an invalid delta path.');
        if (subPath && path && !subPath.startsWith('response/')) subPath = `${path}/${subPath}`;
        this.apply(sub.o ?? 'SET', subPath, sub.v, depth + 1);
      }
      return;
    }
    const parts = path.split('/').filter(Boolean).map(key => key === 'message_id' ? 'id' : key);
    if (parts.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw fail('invalid_response', 'the website returned an unsafe delta path.');
    if (!parts.length || (parts.length === 1 && parts[0] === 'response')) {
      const snapshot = value?.response ?? value;
      if (!object(snapshot)) throw fail('invalid_response', 'the website returned an invalid assistant snapshot.');
      this.message = structuredClone(snapshot);
      if (this.message.message_id !== undefined) this.message.id = this.message.message_id;
      return;
    }
    if (parts[0] !== 'response') return;
    let node = this.message;
    for (const key of parts.slice(1, -1)) {
      const index = Array.isArray(node) ? arrayIndex(key, node.length) : key;
      if (!Object.hasOwn(node, index)) {
        if (op !== 'SET' || Array.isArray(node)) throw fail('invalid_response', 'the website delta references a missing field.');
        node[index] = {};
      }
      node = node[index];
      if (!object(node) && !Array.isArray(node)) throw fail('invalid_response', 'the website delta references a non-container field.');
    }
    const key = Array.isArray(node) ? arrayIndex(parts.at(-1), node.length, op === 'SET') : parts.at(-1);
    if (op === 'SET' || !Object.hasOwn(node, key)) node[key] = structuredClone(value);
    else if (typeof node[key] === 'string' && typeof value === 'string') node[key] += value;
    else if (Array.isArray(node[key])) node[key].push(...(Array.isArray(value) ? value : [value]));
    else throw fail('invalid_response', 'the website returned an incompatible append delta.');
  }
  handle({ event, data }) {
    if (data === '[DONE]') { this.done = true; return; }
    if (event && !['ready', 'delta', 'error', 'toast', 'hint'].includes(event)) return;
    if (!object(data)) throw fail('invalid_response', 'the website returned an invalid stream event.');
    if (event === 'error' || data.error || ((event === 'toast' || event === 'hint') && data.type === 'error')) throw fail('upstream_error', 'the website reported a generation error.');
    if (event === 'ready') { this.messageId = data.response_message_id ?? null; return; }
    if (event && event !== 'delta') return;
    if (!Object.hasOwn(data, 'v')) return;
    this.op = data.o ?? this.op;
    this.path = data.p ?? this.path;
    this.apply(this.op, this.path, data.v);
    if (JSON.stringify(this.message).length > 1_000_000) throw fail('response_too_large', 'the website assistant response exceeded the bridge limit.');
  }
  result() {
    const complete = ['FINISHED', 'COMPLETE', 'COMPLETED'].includes(this.message.status);
    if ((this.message.status !== undefined && !complete) || (!complete && !this.done)) throw fail('response_incomplete', 'the website stream ended before the answer completed.');
    if (!Array.isArray(this.message.fragments)) throw fail('invalid_response', 'the website returned invalid assistant fragments.');
    const text = this.message.fragments.filter(fragment => ['RESPONSE', 'TEMPLATE_RESPONSE'].includes(fragment?.type)).map(fragment => {
      if (typeof fragment.content === 'string') return fragment.content;
      if (Array.isArray(fragment.content)) return fragment.content.map(part => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        throw fail('invalid_response', 'the website returned non-text assistant content.');
      }).join('');
      throw fail('invalid_response', 'the website returned non-text assistant content.');
    }).join('');
    if (!text.trim()) throw fail('empty_response', 'the website completed without an answer.');
    if (text.length > 200_000) throw fail('response_too_large', 'the website assistant response exceeded the bridge limit.');
    return text;
  }
}

export function createDeepSeekAdapter({ token, fetchImpl = globalThis.fetch, upstreamModel, timeoutMs = 180_000, solveChallenge = solveDeepSeekChallenge } = {}) {
  if (upstreamModel !== undefined && upstreamModel !== 'default') throw fail('model_unavailable', 'DeepSeek exposes the account website default model only.', 400);
  const deviceId = randomUUID();
  const headers = () => ({ Authorization: `Bearer ${requireToken(token, 'DeepSeek')}`, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Referer: `${BASE}/`, Origin: BASE, Accept: '*/*', 'x-client-bundle-id': 'com.deepseek.chat', 'x-client-platform': 'web', 'x-client-version': '2.3.0', 'x-client-locale': 'en-US', 'x-client-timezone-offset': '0' });
  async function json(path, body, signal) {
    const response = await send(fetchImpl, `${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST', signal, headers: { ...headers(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, 'DeepSeek');
    return businessData(await readJson(response, 'DeepSeek', signal));
  }
  const adapter = {
    id: 'deepseek', label: 'DeepSeek', models: MODELS.map(model => ({ ...model })),
    async checkAuth({ signal } = {}) { await json('/api/v0/users', null, requestSignal(signal, 20_000)); return true; },
    async discoverModels({ signal } = {}) {
      const data = await json(`/api/v0/client/settings?did=${deviceId}&scope=model`, undefined, requestSignal(signal, 20_000));
      adapter.models = accountModels(data);
      return adapter.models.map(model => ({ ...model }));
    },
    async complete({ model = 'deepseek-web', prompt }, { signal } = {}) {
      if (!MODELS.some(item => item.id === model)) throw fail('model_not_found', 'the requested bridge model is unsupported.', 400);
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 200_000) throw fail('invalid_prompt', 'a bounded non-empty text prompt is required.', 400);
      const bounded = requestSignal(signal, timeoutMs);
      const models = await adapter.discoverModels({ signal: bounded });
      if (!models.some(item => item.id === model)) throw fail('model_unavailable', 'thinking is unavailable on the current website account.', 400);
      const session = await json('/api/v0/chat_session/create', {}, bounded);
      const chatId = session.chat_session?.id;
      if (typeof chatId !== 'string' || !chatId || chatId.length > 256) throw fail('invalid_response', 'the website did not create a valid chat.');
      const reconstructor = new DeepSeekStream();
      let submitted = false;
      let finished = false;
      try {
        const { challenge } = await json('/api/v0/chat/create_pow_challenge', { target_path: '/api/v0/chat/completion' }, bounded);
        validateChallenge(challenge);
        const answer = await solveChallenge(challenge, { signal: bounded });
        const proof = proofHeader(challenge, answer);
        submitted = true;
        const response = await send(fetchImpl, `${BASE}/api/v0/chat/completion`, { method: 'POST', signal: bounded, headers: { ...headers(), Accept: 'text/event-stream', 'Content-Type': 'application/json', 'X-DS-PoW-Response': proof },
          body: JSON.stringify({ chat_session_id: chatId, parent_message_id: null, model_type: 'default', prompt, ref_file_ids: [], thinking_enabled: model === 'deepseek-web-thinking', search_enabled: false, action: null, preempt: false }) }, 'DeepSeek');
        if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
          businessData(await readJson(response, 'DeepSeek', bounded));
          throw fail('invalid_response', 'the website did not return a generation stream.');
        }
        for await (const event of readSse(response, 'DeepSeek', bounded)) reconstructor.handle(event);
        const text = reconstructor.result();
        finished = true;
        return text;
      } finally {
        if (submitted && !finished) await json('/api/v0/chat/stop_stream', { chat_session_id: chatId, message_id: reconstructor.messageId ?? reconstructor.message.id ?? null }, AbortSignal.timeout(3000)).catch(() => {});
      }
    },
  };
  return adapter;
}
