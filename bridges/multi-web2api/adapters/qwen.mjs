// Protocol adapted from MIT FreeTokenAPI a54a9bb5; see vendor/README.md.
import { randomUUID } from 'node:crypto';
import { adapterError, readJson, readSse, requestSignal, requireToken, send } from './direct-http.mjs';

const BASE = 'https://chat.qwen.ai';
const ANSWER_PHASES = new Set(['answer', 'deep_research_answer', 'ReportGeneration', 'PdfMdGen']);
// Model discovery confirms account text routes, but the inspected protocol has
// no account capability flag proving that a separate thinking mode is enabled.
const MODELS = [{ id: 'qwen-web', name: 'Qwen Web' }];

function qwenError(code) {
  if (['unauthorized', 'Unauthorized', 'Invalid token', 'Forbidden', 'forbidden', 401, 403].includes(code)) {
    return adapterError('Qwen', 401, 'authentication_required', 'the web session expired or lacks access; sign in again.');
  }
  if (['Too_Many_Requests', 'RateLimited', 'quotaLimited', 429].includes(code)) {
    return adapterError('Qwen', 429, 'rate_limited', 'the website rate limit was reached; try again later.');
  }
  if (typeof code === 'string' && /context|maxinput|toolong|lengthexceeded|tokenlimit/i.test(code.replace(/[^a-z0-9]/gi, ''))) {
    return adapterError('Qwen', 400, 'context_length_exceeded', 'the prompt exceeds the website context limit.');
  }
  return adapterError('Qwen', 502, 'upstream_error', 'the website rejected the request or reported a generation error.');
}

function businessData(payload) {
  if (!payload || payload.success !== true) throw qwenError(payload?.data?.code ?? payload?.error?.code ?? payload?.code);
  if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    throw adapterError('Qwen', 502, 'invalid_response', 'the website returned an invalid response envelope.');
  }
  return payload.data;
}

export function createQwenAdapter({ token, fetchImpl = globalThis.fetch, upstreamModel, timeoutMs = 180_000 } = {}) {
  const headers = () => ({
    Authorization: `Bearer ${requireToken(token, 'Qwen')}`,
    Cookie: `token=${requireToken(token, 'Qwen')}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9',
    Origin: BASE, Referer: `${BASE}/`, source: 'web', version: '0.2.83',
    'sec-ch-ua': '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
    'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
    'X-Request-Id': randomUUID(), Timezone: new Date().toString().replace(/ \(.+\)$/, ''),
  });
  async function json(path, body, signal) {
    const response = await send(fetchImpl, `${BASE}${path}`, {
      method: body === undefined ? 'GET' : 'POST', signal,
      headers: { ...headers(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, 'Qwen');
    return businessData(await readJson(response, 'Qwen', signal));
  }
  async function discover(signal) {
    const data = await json('/api/v2/models/', undefined, signal);
    if (!Array.isArray(data.data) || data.data.length > 256) throw adapterError('Qwen', 502, 'invalid_response', 'model discovery returned an invalid model list.');
    const chat = data.data.filter(model => {
      if (typeof model?.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(model.id)) return false;
      const types = model.info?.meta?.chat_type;
      return types === undefined || (Array.isArray(types) && types.every(type => typeof type === 'string') && types.includes('t2t'));
    });
    if (!chat.length) throw adapterError('Qwen', 503, 'model_unavailable', 'the account did not advertise an available chat model.');
    const selected = upstreamModel ? chat.find(model => model.id === upstreamModel) : chat[0];
    if (!selected) throw adapterError('Qwen', 400, 'model_unavailable', 'the configured website model is not available on this account.');
    return selected;
  }
  const adapter = {
    id: 'qwen', label: 'Qwen', models: MODELS.map(model => ({ ...model })),
    async checkAuth({ signal } = {}) {
      const bounded = requestSignal(signal, 20_000);
      const response = await send(fetchImpl, `${BASE}/api/v1/auths/`, { headers: headers(), signal: bounded }, 'Qwen');
      const payload = await readJson(response, 'Qwen', bounded);
      if (payload?.success !== true && !payload?.id && !payload?.data?.id) throw qwenError('Unauthorized');
      return true;
    },
    async discoverModels({ signal } = {}) {
      const websiteModel = await discover(requestSignal(signal, 20_000));
      const websiteName = typeof websiteModel.name === 'string' && websiteModel.name.trim() && websiteModel.name.length <= 128 && !/[\r\n\0]/.test(websiteModel.name) ? websiteModel.name : websiteModel.id;
      adapter.models = MODELS.map(model => ({ ...model, upstream_model: websiteModel.id, upstream_name: websiteName }));
      return adapter.models.map(model => ({ ...model }));
    },
    async complete({ model = 'qwen-web', prompt }, { signal } = {}) {
      if (model === 'qwen-web-thinking') throw adapterError('Qwen', 400, 'model_unavailable', 'this account has not advertised a supported thinking mode.');
      if (!MODELS.some(item => item.id === model)) throw adapterError('Qwen', 400, 'model_not_found', 'the requested bridge model is not supported.');
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 200_000) throw adapterError('Qwen', 400, 'invalid_prompt', 'a bounded non-empty text prompt is required.');
      const bounded = requestSignal(signal, timeoutMs);
      const websiteModel = (await discover(bounded)).id;
      const created = await json('/api/v2/chats/new', {
        chatId: '', models: [websiteModel], project_id: '', timestamp: Date.now(), chat_type: 't2t', chat_mode: 'normal',
      }, bounded);
      if (typeof created.id !== 'string' || !created.id || created.id.length > 256) throw adapterError('Qwen', 502, 'invalid_response', 'the website did not create a chat.');
      const chatId = created.id;
      const timestamp = Math.floor(Date.now() / 1000);
      const thinking = false;
      const userFid = randomUUID();
      const responseFid = randomUUID();
      let responseId = null;
      let finished = false;
      let terminalSeen = false;
      let submitted = false;
      try {
        submitted = true;
        const response = await send(fetchImpl, `${BASE}/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`, {
          method: 'POST', signal: bounded,
          headers: { ...headers(), Accept: 'text/event-stream', 'Content-Type': 'application/json', 'X-Accel-Buffering': 'no', Referer: `${BASE}/c/${encodeURIComponent(chatId)}` },
          body: JSON.stringify({
            stream: true, version: '2.1', incremental_output: true, chatId, parentId: '', chat_id: chatId,
            chat_mode: 'normal', model: websiteModel, parent_id: null, timestamp,
            messages: [{
              id: null, fid: userFid, parentId: null, childrenIds: [responseFid], role: 'user', content: prompt,
              user_action: 'chat', files: [], timestamp, models: [websiteModel], model: '', chat_type: 't2t',
              feature_config: { thinking_enabled: thinking, output_schema: 'phase', research_mode: 'normal', auto_thinking: thinking, thinking_mode: thinking ? 'Auto' : 'Manual', thinking_format: 'summary', auto_search: false },
              extra: { meta: { subChatType: 't2t' } }, sub_chat_type: 't2t', parent_id: null,
            }],
          }),
        }, 'Qwen');
        if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
          businessData(await readJson(response, 'Qwen', bounded));
          throw adapterError('Qwen', 502, 'invalid_response', 'the website did not return a generation stream.');
        }
        let text = '';
        for await (const { event, data } of readSse(response, 'Qwen', bounded)) {
          if (event === 'error') throw qwenError(data?.code);
          if (data === '[DONE]') { terminalSeen = true; continue; }
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw adapterError('Qwen', 502, 'invalid_response', 'the website returned an invalid stream event.');
          if (data.error) throw qwenError(data.error?.code);
          if (data['response.stopped']) throw adapterError('Qwen', 502, 'response_incomplete', 'the website stopped the answer before completion.');
          const receivedId = data.response_id ?? data['response.created']?.response_id;
          if (receivedId !== undefined) {
            if (typeof receivedId !== 'string' || !receivedId || receivedId.length > 256) throw adapterError('Qwen', 502, 'invalid_response', 'the website returned an invalid response ID.');
            responseId = receivedId;
          }
          if (data.done === true) terminalSeen = true;
          const delta = data.choices?.[0]?.delta;
          if (['error', 'failed', 'stopped', 'cancelled'].includes(delta?.status)) throw adapterError('Qwen', 502, 'response_incomplete', 'the website did not finish the assistant response.');
          if (delta && ANSWER_PHASES.has(delta.phase)) {
            if (delta.content !== undefined && typeof delta.content !== 'string') throw adapterError('Qwen', 502, 'invalid_response', 'the website returned non-text assistant content.');
            if (typeof delta.content === 'string') text += delta.content;
            if (text.length > 200_000) throw adapterError('Qwen', 502, 'response_too_large', 'the website assistant response exceeded the bridge limit.');
            if (delta.status === 'finished') terminalSeen = true;
          }
        }
        if (!terminalSeen) throw adapterError('Qwen', 502, 'response_incomplete', 'the website stream ended before the answer completed.');
        if (!text.trim()) throw adapterError('Qwen', 502, 'empty_response', 'the website completed without an answer.');
        finished = true;
        return text;
      } finally {
        if (submitted && !finished) {
          await json('/api/v2/chat/completions/stop', { chat_id: chatId, response_id: responseId }, AbortSignal.timeout(3000)).catch(() => {});
        }
      }
    },
  };
  return adapter;
}
