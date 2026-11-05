import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createDeepSeekAdapter, DeepSeekStream } from '../bridges/multi-web2api/adapters/deepseek.mjs';
import { createQwenAdapter } from '../bridges/multi-web2api/adapters/qwen.mjs';
import { readJson, readSse, requireToken, send } from '../bridges/multi-web2api/adapters/direct-http.mjs';
import { proofHeader, solveDeepSeekChallenge, validateChallenge } from '../bridges/multi-web2api/adapters/deepseek-pow.mjs';

const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const stream = text => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
const ds = value => json({ code: 0, data: { biz_code: 0, biz_data: value } });
const event = (data, name) => `${name ? `event: ${name}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const collect = async iterator => { const result = []; for await (const item of iterator) result.push(item); return result; };
const challenge = () => ({ algorithm: 'DeepSeekHashV1', challenge: '0'.repeat(64), salt: 'fixture-salt', expire_at: Date.now() + 3600000, difficulty: 32, signature: 'fixture-signature', target_path: '/api/v0/chat/completion' });
const configs = thinking => ({ settings: { model_configs: { value: [{ model_type: 'default', enabled: true, switchable: true, think_feature: thinking ? {} : null }] } } });

function qwenFixture(text, options = {}) {
  const calls = [];
  const adapter = createQwenAdapter({ token: 'fixture-token', ...options, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/v2/models/')) return json({ success: true, data: { data: [{ id: 'image-only', info: { meta: { chat_type: ['t2i'] } } }, { id: 'account-chat', name: 'Account Website Chat', info: { meta: { chat_type: ['t2t'] } } }] } });
    if (url.endsWith('/api/v1/auths/')) return json({ id: 'fixture-user' });
    if (url.endsWith('/api/v2/chats/new')) return json({ success: true, data: { id: 'fixture-chat' } });
    if (url.endsWith('/stop')) return json({ success: true, data: {} });
    return stream(text);
  } });
  return { adapter, calls };
}

function deepseekFixture(text, options = {}) {
  const calls = [];
  let proofs = 0;
  const adapter = createDeepSeekAdapter({ token: 'fixture-token', solveChallenge: async () => { proofs++; return 7; }, ...options, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/client/settings?')) return ds(configs(true));
    if (url.endsWith('/users')) return ds({ id: 'fixture-user' });
    if (url.endsWith('/chat_session/create')) return ds({ chat_session: { id: 'fixture-chat' } });
    if (url.endsWith('/create_pow_challenge')) return ds({ challenge: challenge() });
    if (url.endsWith('/stop_stream')) return ds({});
    return stream(text);
  } });
  return { adapter, calls, proofs: () => proofs };
}

test('direct transport rejects redirects/errors without exposing response bodies or credentials', async () => {
  for (const [status, code] of [[401, 'authentication_required'], [403, 'verification_required'], [429, 'rate_limited'], [500, 'upstream_error']]) {
    await assert.rejects(send(async (_url, init) => {
      assert.equal(init.redirect, 'error');
      return new Response('private-upstream-body', { status });
    }, 'https://chat.qwen.ai/', {}, 'Qwen'), error => error.code === code && !error.message.includes('private-upstream-body'));
  }
  await assert.rejects(send(async () => { throw new Error('private-token'); }, 'https://chat.qwen.ai/', {}, 'Qwen'), error => error.code === 'upstream_unavailable' && !error.message.includes('private-token'));
  for (const value of ['', 'Bearer value', 'cookie=abc;other=x', 'a'.repeat(16385), 'abc\nxyz']) assert.throws(() => requireToken(value, 'Qwen'));
});

test('direct JSON/SSE reject malformed UTF-8, truncated events and oversized bodies', async () => {
  const invalidUtf8 = new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125]);
  await assert.rejects(readJson(new Response(invalidUtf8, { headers: { 'content-type': 'application/json' } }), 'Qwen'), error => error.code === 'invalid_response');
  await assert.rejects(collect(readSse(stream('data: {"done":true}'), 'Qwen')), error => error.code === 'response_incomplete');
  await assert.rejects(collect(readSse(stream(': ping\ndata: {"done":true}'), 'Qwen')), error => error.code === 'response_incomplete');
  await assert.rejects(collect(readSse(stream('data: not-json\n\n'), 'Qwen')), error => error.code === 'invalid_response');
  await assert.rejects(readJson(json('x'.repeat(2 * 1024 * 1024)), 'Qwen'), error => error.code === 'response_too_large');
  await assert.rejects(collect(readSse(stream(event({ content: 'x'.repeat(1_000_001) })), 'Qwen')), error => error.code === 'response_too_large');
  const records = await collect(readSse(stream(': ping\r\n\r\nevent: delta\r\ndata: {"value":\r\ndata: "ok"}\r\n\r\ndata: [DONE]\r\n\r\n'), 'Qwen'));
  assert.deepEqual(records, [{ event: 'delta', data: { value: 'ok' } }, { event: null, data: '[DONE]' }]);
});

test('direct stream cancellation cancels the body and removes its abort listener', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } });
  const reading = readJson(response, 'Qwen', controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  await assert.rejects(reading, error => error.code === 'request_aborted');
  assert.equal(cancelled, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('Qwen discovers an account text model and sends its actual website model with token auth', async () => {
  const fixture = qwenFixture(event({ choices: [{ delta: { phase: 'think', content: 'private thought', status: 'finished' } }] }) + event({ choices: [{ delta: { phase: 'answer', content: 'Hello', status: 'finished' } }] }));
  assert.equal(await fixture.adapter.checkAuth(), true);
  const models = await fixture.adapter.discoverModels();
  assert.deepEqual(models.map(model => model.id), ['qwen-web']);
  assert.ok(models.every(model => model.upstream_model === 'account-chat'));
  assert.ok(models.every(model => model.upstream_name === 'Account Website Chat'));
  await assert.rejects(fixture.adapter.complete({ model: 'qwen-web-thinking', prompt: 'fixture' }), error => error.code === 'model_unavailable');
  assert.equal(await fixture.adapter.complete({ model: 'qwen-web', prompt: 'fixture prompt' }), 'Hello');
  const request = fixture.calls.find(call => call.url.includes('/chat/completions?'));
  assert.equal(request.init.headers.Authorization, 'Bearer fixture-token');
  assert.equal(request.init.headers.Cookie, 'token=fixture-token');
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, 'account-chat');
  assert.equal(body.messages[0].feature_config.thinking_enabled, false);
  assert.deepEqual(body.messages[0].files, []);
  assert.equal(body.messages[0].content, 'fixture prompt');
  await assert.rejects(qwenFixture('', { upstreamModel: 'missing-model' }).adapter.discoverModels(), error => error.code === 'model_unavailable');
});

test('Qwen excludes non-text and malformed explicit model metadata', async () => {
  const invalidTypes = ['t2i', 't2t', null, {}, [], ['t2i'], ['t2t', 7]];
  const discover = models => createQwenAdapter({ token: 'fixture-token', fetchImpl: async () => json({ success: true, data: { data: models } }) }).discoverModels();
  for (const types of invalidTypes) {
    const invalid = { id: 'image-route', info: { meta: { chat_type: types } } };
    await assert.rejects(discover([invalid]), error => error.code === 'model_unavailable');
    const models = await discover([invalid, { id: 'text-route', info: { meta: { chat_type: ['t2t'] } } }]);
    assert.equal(models[0].upstream_model, 'text-route');
  }
  assert.equal((await discover([{ id: 'account-default' }]))[0].upstream_model, 'account-default');
});

test('Qwen rejects incomplete, stopped, malformed and oversized replies and sends stop after failure', async () => {
  const answer = event({ choices: [{ delta: { phase: 'answer', content: 'partial' } }] });
  for (const [text, code] of [
    [answer, 'response_incomplete'],
    [event({ choices: [{ delta: { phase: 'think', content: 'thought', status: 'finished' } }] }), 'response_incomplete'],
    [answer + event({ 'response.stopped': true, done: true }), 'response_incomplete'],
    [answer + event({ done: true }) + 'data: broken\n\n', 'invalid_response'],
    [event({ choices: [{ delta: { phase: 'answer', content: 'x'.repeat(200001), status: 'finished' } }] }), 'response_too_large'],
    [event({ choices: [{ delta: { phase: 'answer', content: 7, status: 'finished' } }] }), 'invalid_response'],
  ]) {
    const fixture = qwenFixture(text);
    await assert.rejects(fixture.adapter.complete({ prompt: 'fixture' }), error => error.code === code);
    assert.ok(fixture.calls.some(call => call.url.endsWith('/stop')));
  }
});

test('Qwen rejects explicit failure statuses outside answer phases even with completion markers', async () => {
  const answer = event({ choices: [{ delta: { phase: 'answer', content: 'partial answer', status: 'finished' } }] });
  for (const status of ['error', 'failed', 'stopped', 'cancelled']) {
    for (const phase of [undefined, 'think', 'thinking_summary', 'other']) {
      const failure = event({ done: true, choices: [{ delta: { status, ...(phase === undefined ? {} : { phase }) } }] });
      const fixture = qwenFixture(answer + failure + event('[DONE]'));
      await assert.rejects(fixture.adapter.complete({ prompt: 'fixture' }), error => error.code === 'response_incomplete');
      assert.ok(fixture.calls.some(call => call.url.endsWith('/stop')));
    }
  }
});

test('DeepSeek reconstructs snapshots, remembered append paths and relative batches without leaking thinking', () => {
  const reconstruction = new DeepSeekStream();
  reconstruction.handle({ event: 'ready', data: { response_message_id: 'reply-id' } });
  reconstruction.handle({ event: 'delta', data: { v: { response: { message_id: 'reply-id', status: 'WIP', fragments: [{ type: 'THINK', content: 'private thought' }, { type: 'RESPONSE', content: 'Hel' }] } } } });
  reconstruction.handle({ event: 'delta', data: { o: 'APPEND', p: 'response/fragments/1/content', v: 'l' } });
  reconstruction.handle({ event: 'delta', data: { v: 'o' } });
  reconstruction.handle({ event: 'delta', data: { o: 'BATCH', p: 'response', v: [{ o: 'APPEND', p: 'fragments/1/content', v: ' world' }, { o: 'SET', p: 'status', v: 'FINISHED' }] } });
  assert.equal(reconstruction.result(), 'Hello world');
  assert.equal(reconstruction.messageId, 'reply-id');
  reconstruction.handle({ event: 'delta', data: { o: 'SET', p: 'response', v: { status: 'FINISHED', fragments: [{ type: 'RESPONSE', content: 'Corrected final' }] } } });
  assert.equal(reconstruction.result(), 'Corrected final');
});

test('DeepSeek rejects unfinished status even with DONE, unsafe deltas and error hints', () => {
  for (const status of ['WIP', 'INCOMPLETE', 'CONTEXT_LENGTH_EXCEEDED', 'CONTENT_FILTER', 'CANCELLED']) {
    const reconstruction = new DeepSeekStream();
    reconstruction.handle({ data: { v: { response: { status, fragments: [{ type: 'RESPONSE', content: 'partial' }] } } } });
    reconstruction.handle({ data: '[DONE]' });
    assert.throws(() => reconstruction.result(), error => error.code === 'response_incomplete');
  }
  const reconstruction = new DeepSeekStream();
  assert.throws(() => reconstruction.handle({ data: { o: 'SET', p: 'response/__proto__/polluted', v: true } }), error => error.code === 'invalid_response');
  assert.equal({}.polluted, undefined);
  assert.throws(() => reconstruction.handle({ event: 'hint', data: { type: 'error', content: 'private upstream content' } }), error => error.code === 'upstream_error' && !error.message.includes('private upstream content'));
});

test('DeepSeek discovers enabled account capabilities and uses a fresh proof for each website request', async () => {
  const text = event({ response_message_id: 'reply' }, 'ready') + event({ v: { response: { status: 'FINISHED', fragments: [{ type: 'RESPONSE', content: 'OK' }] } } }, 'delta');
  const fixture = deepseekFixture(text);
  assert.equal(await fixture.adapter.checkAuth(), true);
  assert.deepEqual((await fixture.adapter.discoverModels()).map(model => model.id), ['deepseek-web', 'deepseek-web-thinking']);
  assert.equal(await fixture.adapter.complete({ model: 'deepseek-web-thinking', prompt: 'first fixture' }), 'OK');
  assert.equal(await fixture.adapter.complete({ model: 'deepseek-web', prompt: 'second fixture' }), 'OK');
  assert.equal(fixture.proofs(), 2);
  const requests = fixture.calls.filter(call => call.url.endsWith('/chat/completion'));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.headers.Authorization, 'Bearer fixture-token');
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model_type, 'default');
  assert.equal(body.thinking_enabled, true);
  assert.equal(body.search_enabled, false);
  assert.deepEqual(body.ref_file_ids, []);
  const proof = JSON.parse(Buffer.from(requests[0].init.headers['X-DS-PoW-Response'], 'base64').toString());
  assert.equal(proof.answer, 7);
  assert.equal(proof.signature, 'fixture-signature');
});

test('DeepSeek account discovery rejects unsupported thinking and business errors before creating chats', async () => {
  const calls = [];
  const adapter = createDeepSeekAdapter({ token: 'fixture', fetchImpl: async url => { calls.push(url); return ds(configs(false)); } });
  assert.deepEqual((await adapter.discoverModels()).map(model => model.id), ['deepseek-web']);
  await assert.rejects(adapter.complete({ model: 'deepseek-web-thinking', prompt: 'fixture' }), error => error.code === 'model_unavailable');
  assert.ok(calls.every(url => url.includes('/client/settings?')));
  const denied = createDeepSeekAdapter({ token: 'fixture', fetchImpl: async () => json({ code: 0, data: { biz_code: 40029, biz_msg: 'private account data' } }) });
  await assert.rejects(denied.discoverModels(), error => error.status === 401 && !error.message.includes('private account data'));
  const broken = deepseekFixture(event({ v: { response: { status: 'WIP', fragments: [{ type: 'RESPONSE', content: 'partial' }] } } }, 'delta'));
  await assert.rejects(broken.adapter.complete({ prompt: 'fixture' }), error => error.code === 'response_incomplete');
  assert.ok(broken.calls.some(call => call.url.endsWith('/stop_stream')));
});

// Independent BigInt implementation used only to construct a known work fixture.
// The production solver uses the pinned upstream WASM in an isolated worker.
function fixtureHash(input) {
  const mask = (1n << 64n) - 1n;
  const constants = [0x8082n, 0x800000000000808An, 0x8000000080008000n, 0x808Bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n, 0x8An, 0x88n, 0x80008009n, 0x8000000An, 0x8000808Bn, 0x800000000000008Bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x800An, 0x800000008000000An, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
  const rotations = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
  const rotate = (value, bits) => ((value << BigInt(bits)) | (value >> BigInt(64 - bits))) & mask;
  const source = Buffer.from(input);
  const bytes = Buffer.alloc(Math.ceil((source.length + 1) / 136) * 136);
  source.copy(bytes); bytes[source.length] = 6; bytes[bytes.length - 1] |= 128;
  const state = Array(25).fill(0n);
  for (let offset = 0; offset < bytes.length; offset += 136) {
    for (let index = 0; index < 17; index++) state[index] ^= bytes.readBigUInt64LE(offset + index * 8);
    for (const constant of constants) {
      const column = Array(5).fill(0n), differences = Array(5).fill(0n), lanes = Array(25).fill(0n);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) column[x] ^= state[x + 5 * y];
      for (let x = 0; x < 5; x++) differences[x] = column[(x + 4) % 5] ^ rotate(column[(x + 1) % 5], 1);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) state[x + 5 * y] ^= differences[x];
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) lanes[y + 5 * ((2 * x + 3 * y) % 5)] = rotate(state[x + 5 * y], rotations[x][y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) state[x + 5 * y] = lanes[x + 5 * y] ^ ((~lanes[(x + 1) % 5 + 5 * y]) & lanes[(x + 2) % 5 + 5 * y]);
      state[0] ^= constant;
    }
  }
  const result = Buffer.alloc(32);
  for (let index = 0; index < 4; index++) result.writeBigUInt64LE(state[index], index * 8);
  return result.toString('hex');
}

test('DeepSeek pinned WASM solves an independent work fixture and validates proof/abort/limits', async () => {
  const work = challenge();
  work.challenge = fixtureHash(`${work.salt}_${work.expire_at}_7`);
  assert.equal(await solveDeepSeekChallenge(work), 7);
  assert.equal(JSON.parse(Buffer.from(proofHeader(work, 7), 'base64').toString()).signature, work.signature);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(solveDeepSeekChallenge(work, { signal: controller.signal }), error => error.code === 'request_aborted');
  assert.throws(() => validateChallenge({ ...work, difficulty: 100000001 }), error => error.code === 'work_limit_exceeded');
  assert.throws(() => validateChallenge({ ...work, expire_at: Date.now() - 1 }), error => error.code === 'expired_challenge');
  assert.throws(() => proofHeader(work, work.difficulty), error => error.code === 'invalid_proof');
});

test('DeepSeek isolated work terminates on active cancellation and its elapsed-time limit', async () => {
  const work = { ...challenge(), difficulty: 100_000_000 };
  await assert.rejects(solveDeepSeekChallenge(work, { timeoutMs: 1 }), error => error.code === 'work_timeout');
  const controller = new AbortController();
  const solving = solveDeepSeekChallenge(work, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 10);
  try { await assert.rejects(solving, error => error.code === 'request_aborted'); }
  finally { clearTimeout(timer); }
});
