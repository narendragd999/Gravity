import assert from 'node:assert/strict';
import http from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { createWebApiServer } from '../bridges/multi-web2api/server.mjs';
import { parseZaiStream } from '../bridges/multi-web2api/adapters/browser-stream.mjs';
import { editedReasoningGreeting, greeting, splitReasoningGreeting } from './fixtures/zai-protocol.mjs';

const TOKEN = 'fixture-local-api-token-123456789';
const TOOL = { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } };
const CALL = { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: { path: 'README.md' } } };
const basic = (extra = {}) => ({ model: 'qwen-web', messages: [{ role: 'user', content: 'Hello' }], ...extra });
const envelope = (content, calls = []) => `\`\`\`json\n${JSON.stringify({ content, tool_calls: calls })}\n\`\`\``;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const adapter = (complete = async () => 'Hello back', extra = {}) => ({ id: 'qwen', label: 'Qwen', models: [{ id: 'qwen-web' }], complete, ...extra });

async function fixture(t, adapters = [adapter()], options = {}) {
  const service = createWebApiServer({ adapters, apiToken: TOKEN, port: 0, ...options });
  const address = await service.start();
  t.after(() => service.stop());
  return {
    ...address,
    service,
    get: (path, headers = {}) => fetch(`${address.url}${path}`, { headers: { Authorization: `Bearer ${TOKEN}`, ...headers } }),
    post: (body, options = {}) => fetch(`${address.url}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...options.headers }, body: typeof body === 'string' ? body : JSON.stringify(body), signal: options.signal })
  };
}

function events(text) {
  return text.trim().split('\n\n').map(event => {
    assert.ok(event.startsWith('data: '));
    return event.slice(6) === '[DONE]' ? '[DONE]' : JSON.parse(event.slice(6));
  });
}

function rawPost(app, headers = {}, body = JSON.stringify(basic())) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: app.host, port: app.port, path: '/v1/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, text, json: () => JSON.parse(text) });
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}

test('binds only loopback, requires a strong local token, and rejects ambiguous provider/model configuration', () => {
  assert.throws(() => createWebApiServer({ adapters: [], apiToken: TOKEN, host: '0.0.0.0' }), /loopback/);
  assert.throws(() => createWebApiServer({ adapters: [], apiToken: 'short' }), /16/);
  assert.throws(() => createWebApiServer({ adapters: [], apiToken: 'contains whitespace' }), /non-whitespace/);
  assert.throws(() => createWebApiServer({ adapters: [adapter(), adapter()], apiToken: TOKEN }), /unique/);
  assert.throws(() => createWebApiServer({ adapters: [adapter(), adapter(undefined, { id: 'deepseek' })], apiToken: TOKEN }), /globally unique/);
  assert.throws(() => createWebApiServer({ adapters: [adapter(undefined, { id: 'other' })], apiToken: TOKEN }), /supported provider/);
});

test('health is minimal; model and status discovery require local bearer authentication', async t => {
  const app = await fixture(t);
  const health = await fetch(`${app.url}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  for (const path of ['/v1/models', '/status']) {
    const absent = await fetch(`${app.url}${path}`);
    assert.equal(absent.status, 401);
    assert.equal(absent.headers.get('www-authenticate'), 'Bearer');
    const wrong = await app.get(path, { Authorization: 'Bearer wrong-token' });
    assert.equal(wrong.status, 401);
  }
  const models = await app.get('/v1/models');
  assert.equal(models.status, 200);
  assert.deepEqual((await models.json()).data, [{ id: 'qwen-web', object: 'model', created: 0, owned_by: 'qwen' }]);
  const status = await (await app.get('/status')).json();
  assert.deepEqual(status, { status: 'ok', streaming: 'buffered', providers: [{ id: 'qwen', label: 'Qwen', models: ['qwen-web'], busy: false, browserProfileOpen: false }] });
  assert.equal((await app.get('/missing')).status, 404);
});

test('account profile release requires authentication and closes only the selected idle adapter', async t => {
  const closed = [], qwen = adapter(undefined, { profileStatus: () => ({ browserProfileOpen: true }), close: async () => closed.push('qwen') });
  const zai = { ...adapter(undefined), id: 'zai', label: 'Z.ai', models: [{ id: 'zai-web' }], close: async () => closed.push('zai') };
  const app = await fixture(t, [qwen, zai]);
  const denied = await fetch(`${app.url}/profiles/qwen/close`, { method: 'POST' });
  assert.equal(denied.status, 401); assert.deepEqual(closed, []);
  const released = await fetch(`${app.url}/profiles/qwen/close`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(released.status, 200); assert.deepEqual(await released.json(), { siteId: 'qwen', released: true });
  assert.deepEqual(closed, ['qwen']);
  const withBody = await fetch(`${app.url}/profiles/zai/close`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: 'unexpected' });
  assert.equal(withBody.status, 400); assert.deepEqual(closed, ['qwen']);
});

test('profile release and generation cannot overlap for the same provider', async t => {
  const closing = deferred(); let started = false;
  const app = await fixture(t, [adapter(undefined, { close: async () => { started = true; await closing.promise; } })]);
  const release = fetch(`${app.url}/profiles/qwen/close`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
  while (!started) await nextTurn();
  const blocked = await app.post(basic()); assert.equal(blocked.status, 409);
  assert.equal((await (await app.get('/status')).json()).providers[0].busy, true);
  closing.resolve(); assert.equal((await release).status, 200);
  assert.equal((await app.post(basic())).status, 200);
});

test('blocks browser Origin/Cookie and hostile Host headers even with a valid bearer token', async t => {
  let calls = 0;
  const app = await fixture(t, [adapter(async () => { calls++; return 'Hello'; })]);
  for (const headers of [{ Origin: 'https://example.com' }, { Origin: 'null' }, { Cookie: '' }, { Cookie: 'session=secret' }]) {
    const result = await app.post(basic(), { headers });
    assert.equal(result.status, 403, JSON.stringify(headers));
  }
  assert.equal((await app.get('/health', { Origin: 'https://example.com' })).status, 403);
  // fetch controls Host itself in current Node releases; use a raw client.
  for (const Host of ['example.com', '127.0.0.1:1']) assert.equal((await rawPost(app, { Host })).status, 403);
  assert.equal(calls, 0);
});

test('rejects excess raw headers before Origin or Cookie can be silently omitted', async t => {
  let calls = 0;
  const app = await fixture(t, [adapter(async () => { calls++; return 'Hello'; })]);
  const body = JSON.stringify(basic());
  const base = { Host: `127.0.0.1:${app.port}`, 'Content-Length': Buffer.byteLength(body), Connection: 'close' };
  const filler = count => Object.fromEntries(Array.from({ length: count }, (_, index) => [`X-Fixture-${index}`, 'x']));
  assert.equal((await rawPost(app, { ...base, ...filler(27) }, body)).status, 200, 'Exactly 32 headers remain supported.');
  for (const forbidden of [{ Origin: 'https://example.com' }, { Cookie: 'session=secret' }]) {
    const response = await rawPost(app, { ...base, ...filler(32), ...forbidden }, body);
    assert.equal(response.status, 431);
    assert.equal(response.json().error.code, 'request_headers_too_large');
  }
  assert.equal(calls, 1);
});

test('parser-level header size overflow returns a safe 431 without invoking the website', async t => {
  let calls = 0;
  const app = await fixture(t, [adapter(async () => { calls++; return 'Hello'; })]);
  const response = await rawPost(app, { 'X-Large-Fixture': 'x'.repeat(17000) });
  assert.equal(response.status, 431);
  assert.equal(response.json().error.code, 'request_headers_too_large');
  assert.equal(calls, 0);
});

test('localhost binds literal loopback; IPv6 loopback supports authenticated discovery', async t => {
  const local = await fixture(t, [adapter()], { host: 'localhost' });
  assert.equal(local.host, '127.0.0.1');
  assert.equal((await local.get('/v1/models')).status, 200);
  let ipv6;
  try { ipv6 = await fixture(t, [adapter()], { host: '::1' }); }
  catch (error) {
    if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) { t.diagnostic('IPv6 loopback unavailable on this host.'); return; }
    throw error;
  }
  assert.equal(ipv6.host, '::1');
  assert.equal((await ipv6.get('/v1/models')).status, 200);
});

test('routes each exact public model ID and preserves model identity in completions', async t => {
  const received = [];
  const app = await fixture(t, [
    adapter(async (request, { signal }) => { received.push({ provider: 'qwen', ...request, signal }); return 'Qwen answer'; }),
    adapter(async (request, { signal }) => { received.push({ provider: 'deepseek', ...request, signal }); return 'DeepSeek answer'; }, { id: 'deepseek', label: 'DeepSeek', models: [{ id: 'deepseek-web' }, { id: 'deepseek-web-thinking' }] })
  ]);
  const listing = await (await app.get('/v1/models')).json();
  assert.deepEqual(listing.data.map(model => model.id), ['qwen-web', 'deepseek-web', 'deepseek-web-thinking']);
  for (const model of ['qwen-web', 'deepseek-web-thinking']) {
    const response = await app.post(basic({ model, messages: [{ role: 'system', content: 'Be concise.' }, { role: 'user', content: [{ type: 'text', text: 'First' }, { type: 'text', text: 'Second' }] }] }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.model, model);
    assert.equal(result.object, 'chat.completion');
    assert.equal(result.choices[0].finish_reason, 'stop');
    assert.equal('usage' in result, false);
  }
  assert.deepEqual(received.map(value => [value.provider, value.model]), [['qwen', 'qwen-web'], ['deepseek', 'deepseek-web-thinking']]);
  assert.match(received[0].prompt, /\[SYSTEM\]\nBe concise\./);
  assert.match(received[0].prompt, /\[USER\]\nFirst\nSecond/);
  assert.ok(received[0].signal instanceof AbortSignal);
  const missing = await app.post(basic({ model: 'unconfigured-web' }));
  assert.equal(missing.status, 404);
  assert.equal(received.length, 2);
});

test('rejects malformed, non-text, oversized, and unsupported requests before contacting a provider', async t => {
  let calls = 0;
  const app = await fixture(t, [adapter(async () => { calls++; return 'Unexpected'; })]);
  const invalid = [
    null,
    [],
    basic({ stream: 'true' }),
    basic({ stream_options: { include_usage: true } }),
    basic({ stream: true, stream_options: { include_usage: 'yes' } }),
    basic({ temperature: 0.2 }),
    basic({ max_tokens: 0 }),
    basic({ max_tokens: -1 }),
    basic({ max_tokens: 1.5 }),
    basic({ max_tokens: '128' }),
    basic({ max_tokens: null }),
    basic({ max_completion_tokens: 0 }),
    basic({ max_completion_tokens: Number.MAX_SAFE_INTEGER + 1 }),
    basic({ n: 2 }),
    basic({ parallel_tool_calls: 0 }),
    basic({ messages: [] }),
    basic({ messages: Array.from({ length: 257 }, () => ({ role: 'user', content: 'x' })) }),
    basic({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }] }] }),
    basic({ messages: [{ role: 'user', content: 'x'.repeat(120001) }] }),
    basic({ messages: [{ role: 'user', content: 'x\0y' }] }),
    basic({ messages: [{ role: 'unknown', content: 'x' }] }),
    basic({ messages: [{ role: 'assistant', content: null }] }),
    basic({ messages: [{ role: 'tool', content: 'orphan', tool_call_id: 'call_1' }] }),
    basic({ messages: [{ role: 'user', content: 'x', images: [] }] }),
    basic({ tools: [{ type: 'custom', function: { name: 'x' } }] }),
    basic({ tools: [TOOL, TOOL] }),
    basic({ tools: [{ type: 'function', function: { name: 'bad.name' } }] }),
    basic({ tools: [{ type: 'function', function: { name: 'valid', strict: true } }] }),
    basic({ tools: [TOOL], tool_choice: { type: 'function', function: { name: 'unknown_tool' } } }),
    basic({ tool_choice: 'required' })
  ];
  for (const body of invalid) {
    const result = await app.post(JSON.stringify(body));
    assert.equal(result.status, 400, JSON.stringify(body).slice(0, 200));
  }
  const malformed = await app.post('{bad JSON');
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'invalid_json');
  const media = await app.post(basic(), { headers: { 'Content-Type': 'text/plain' } });
  assert.equal(media.status, 415);
  const compressed = await app.post(basic(), { headers: { 'Content-Encoding': 'gzip' } });
  assert.equal(compressed.status, 415);
  assert.equal((await app.post('x'.repeat(512 * 1024 + 1))).status, 413);
  assert.equal(calls, 0);
});

test('bounds declared and chunked uploads and rejects invalid UTF-8 before provider submission', async t => {
  let calls = 0;
  const app = await fixture(t, [adapter(async () => { calls++; return 'Unexpected'; })]);
  assert.equal((await rawPost(app, { 'Content-Length': '600000' }, '')).status, 413);
  assert.equal((await rawPost(app, { 'Transfer-Encoding': 'chunked' }, 'x'.repeat(512 * 1024 + 1))).status, 413);
  const invalidUtf8 = Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]);
  const result = await rawPost(app, {}, invalidUtf8);
  assert.equal(result.status, 400);
  assert.equal(result.json().error.code, 'invalid_json');
  assert.equal(calls, 0);
});

test('accepts client token hints while reporting website generation defaults', async t => {
  const app = await fixture(t);
  for (const extra of [{ max_tokens: 128 }, { max_completion_tokens: 256, stream: true }]) {
    const response = await app.post(basic(extra));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-web2api-generation-controls'), 'website-defaults');
    if (extra.stream) assert.equal(events(await response.text()).at(-1), '[DONE]');
    else assert.equal((await response.json()).choices[0].message.content, 'Hello back');
  }
  assert.equal((await app.post(basic())).headers.has('x-web2api-generation-controls'), false);
});

test('completes a function call and tool-result loop with JSON arguments and declared tools', async t => {
  const prompts = [];
  const outputs = [envelope(null, [CALL]), envelope('The README describes Gravity.')];
  const app = await fixture(t, [adapter(async ({ prompt }) => { prompts.push(prompt); return outputs.shift(); })]);
  const request = basic({ tools: [TOOL], tool_choice: 'required' });
  const first = await app.post(request);
  assert.equal(first.status, 200);
  const toolAnswer = (await first.json()).choices[0];
  assert.equal(toolAnswer.finish_reason, 'tool_calls');
  assert.deepEqual(toolAnswer.message, { role: 'assistant', content: null, tool_calls: [{ ...CALL, function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] });
  assert.match(prompts[0], /AVAILABLE APPLICATION TOOLS/);
  assert.match(prompts[0], /A tool call is required/);
  const second = await app.post({ ...request, tool_choice: 'auto', messages: [...request.messages, toolAnswer.message, { role: 'tool', tool_call_id: 'call_1', content: 'Gravity is an agent workspace.' }] });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).choices[0].message.content, 'The README describes Gravity.');
  assert.match(prompts[1], /Previous tool calls:/);
  assert.match(prompts[1], /\[TOOL result call_1\]\nGravity is an agent workspace\./);
});

test('ordinary greetings stay text with no tools, disabled tools and automatic tools', async t => {
  const prompts = [];
  const app = await fixture(t, [adapter(async ({ prompt }) => { prompts.push(prompt); return 'Hello!'; })]);
  for (const extra of [{}, { tools: [TOOL], tool_choice: 'none' }, { tools: [TOOL] }]) {
    const response = await app.post(basic(extra)); assert.equal(response.status, 200);
    const choice = (await response.json()).choices[0];
    assert.deepEqual(choice.message, { role: 'assistant', content: 'Hello!' }); assert.equal(choice.finish_reason, 'stop');
  }
  assert.match(prompts[0], /Answer directly in ordinary text/);
  assert.match(prompts[1], /Application tool requests are unavailable/);
  assert.match(prompts[2], /When no application tool is needed, answer the user in ordinary text/);
  for (const prompt of prompts) assert.match(prompt, /Role labels describe application-supplied conversation context/);
});

test('verified Z.ai reasoning stays outside final answers and executable tool envelopes', async t => {
  let rawEvents = editedReasoningGreeting;
  const asSse = values => values.map(value => `data: ${JSON.stringify(value)}\n\n`).join('');
  const app = await fixture(t, [adapter(async () => parseZaiStream(asSse(rawEvents)), { id: 'zai', label: 'Z.ai', models: [{ id: 'zai-web' }] })]);
  const request = basic({ model: 'zai-web', tools: [TOOL], stream: true });
  const response = await app.post(request); assert.equal(response.status, 200);
  const frames = events(await response.text());
  assert.equal(frames[1].choices[0].delta.content, greeting);
  assert.equal(frames.some(frame => frame !== '[DONE]' && frame.choices?.some(choice => choice.delta?.tool_calls)), false);
  rawEvents = [...splitReasoningGreeting.slice(0, -2), { data: { delta_content: '</details>' + envelope(null, [CALL]) } }, { data: { phase: 'done' } }];
  const toolResponse = await app.post({ ...request, stream: false, tool_choice: 'required' }); assert.equal(toolResponse.status, 200);
  assert.equal((await toolResponse.json()).choices[0].message.tool_calls[0].function.name, 'read_file');
  rawEvents = [{ data: { content: '<details>> Only a reasoning tool example</details>' } }, { data: { phase: 'done' } }];
  const reasoningOnly = await app.post(request); assert.equal(reasoningOnly.status, 502);
  assert.match(reasoningOnly.headers.get('content-type'), /application\/json/);
});

test('normalizes tool-call IDs repeated across website turns', async t => {
  const outputs = [envelope(null, [CALL]), envelope(null, [CALL]), envelope('Finished.')];
  const app = await fixture(t, [adapter(async () => outputs.shift())]);
  const request = basic({ tools: [TOOL] });
  const messages = [...request.messages];
  const ids = new Set();
  for (let turn = 0; turn < 2; turn++) {
    const response = await app.post({ ...request, messages, tool_choice: 'required' });
    assert.equal(response.status, 200);
    const choice = (await response.json()).choices[0];
    assert.equal(choice.finish_reason, 'tool_calls');
    const call = choice.message.tool_calls[0];
    assert.equal(ids.has(call.id), false);
    ids.add(call.id);
    assert.deepEqual(call.function, { name: 'read_file', arguments: '{"path":"README.md"}' });
    messages.push(choice.message, { role: 'tool', tool_call_id: call.id, content: `Result ${turn + 1}` });
  }
  const final = await app.post({ ...request, messages, tool_choice: 'auto' });
  assert.equal(final.status, 200);
  assert.equal((await final.json()).choices[0].message.content, 'Finished.');
});

test('keeps SSE buffered until validated, then emits OpenAI content/tools/finish chunks and DONE', async t => {
  const started = deferred();
  const output = deferred();
  const app = await fixture(t, [adapter(async () => { started.resolve(); return output.promise; })]);
  let delivered = false;
  const request = app.post(basic({ stream: true, stream_options: { include_usage: true }, tools: [TOOL] })).then(value => { delivered = true; return value; });
  await started.promise;
  await nextTurn();
  assert.equal(delivered, false, 'No successful headers may be sent before provider validation');
  output.resolve(envelope('Reading the file.', [CALL]));
  const response = await request;
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(response.headers.get('x-web2api-stream-mode'), 'buffered');
  const chunks = events(await response.text());
  assert.equal(chunks.at(-1), '[DONE]');
  const frames = chunks.slice(0, -1);
  assert.equal(frames[0].choices[0].delta.role, 'assistant');
  assert.equal(frames[1].choices[0].delta.content, 'Reading the file.');
  assert.deepEqual(frames[2].choices[0].delta.tool_calls, [{ index: 0, ...CALL, function: { name: 'read_file', arguments: '{"path":"README.md"}' } }]);
  assert.equal(frames[3].choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(frames[4].choices, []);
  assert.equal(frames[4].usage, null);
  assert.ok(frames.every(frame => frame.model === 'qwen-web' && frame.id === frames[0].id && frame.object === 'chat.completion.chunk'));
});

test('streams ordinary text without fabricating token usage', async t => {
  const app = await fixture(t);
  const response = await app.post(basic({ stream: true }));
  const chunks = events(await response.text());
  assert.equal(chunks[1].choices[0].delta.content, 'Hello back');
  assert.equal(chunks[2].choices[0].finish_reason, 'stop');
  assert.equal(chunks[3], '[DONE]');
  assert.equal('usage' in chunks[0], false);
});

test('rejects empty, malformed, and invalid structured tool results before SSE succeeds', async t => {
  let nextOutput;
  const app = await fixture(t, [adapter(async () => nextOutput)]);
  let deepArguments = {};
  for (let level = 0; level < 33; level++) deepArguments = { next: deepArguments };
  const invalid = [
    { output: '' },
    { output: ' \n ' },
    { output: null },
    { output: 'x'.repeat(200001) },
    { output: 'Invalid\0output' },
    { output: envelope('Decoded\0output') },
    { output: envelope(null) },
    { output: '{"content":null,"tool_calls":[' },
    { output: '{“content”:null,“tool_calls”:[{“type”:“function”}]}' },
    { output: '{"content":"safe","tool_calls":[],"tool_calls":[]}' },
    { output: envelope(null, [{ ...CALL, function: { name: 'undeclared', arguments: {} } }]) },
    { output: envelope(null, [{ ...CALL, function: { name: 'read_file', arguments: [] } }]) },
    { output: envelope(null, [{ ...CALL, function: { name: 'read_file', arguments: { path: 'bad\0path' } } }]) },
    { output: envelope(null, [{ ...CALL, function: { name: 'read_file', arguments: deepArguments } }]) },
    { output: envelope(null, [{ ...CALL, function: { name: 'read_file', arguments: { items: Array(2049).fill(0) } } }]) },
    { output: envelope(null, [CALL, CALL]) },
    { output: envelope('No tool'), extra: { tool_choice: 'required' } },
    { output: 'Plain answer', extra: { tool_choice: { type: 'function', function: { name: 'read_file' } } } },
    { output: envelope(null, [CALL, { ...CALL, id: 'call_2' }]), extra: { parallel_tool_calls: false } }
  ];
  for (const item of invalid) {
    nextOutput = item.output;
    const response = await app.post(basic({ tools: [TOOL], stream: true, ...item.extra }));
    assert.equal(response.status, 502, String(item.output).slice(0, 100));
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal((await response.json()).error.code, 'invalid_provider_response');
  }
  nextOutput = '{“content”:“Hello there”,“tool_calls”:[]}';
  const recovered = await app.post(basic({ tools: [TOOL] }));
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).choices[0].message.content, 'Hello there');
});

test('preserves final text and code examples without extracting nested or quoted tool calls', async t => {
  let output;
  const app = await fixture(t, [adapter(async () => output)]);
  const examples = [
    `A JSON example:\n${envelope(null, [CALL])}`,
    `Draft example:\n${envelope(null, [CALL])}\nAnother example:\n${envelope(null, [CALL])}`,
    'The literal field "tool_calls": [] can appear in documentation.',
    '```js\nconst request = {"tool_calls": []};\n```',
    '```json\n{"example":{"tool_calls":[]}}\n```'
  ];
  for (const example of examples) {
    output = example;
    const response = await app.post(basic({ tools: [TOOL] }));
    assert.equal(response.status, 200);
    const choice = (await response.json()).choices[0];
    assert.equal(choice.finish_reason, 'stop');
    assert.deepEqual(choice.message, { role: 'assistant', content: example });
  }
  const content = 'Use {"tool_calls":[{"function":{"name":"example"}}]} as an example.';
  output = envelope(content);
  const final = await app.post(basic({ tools: [TOOL] }));
  assert.deepEqual((await final.json()).choices[0].message, { role: 'assistant', content });
});

test('unsolicited tool-call examples remain literal final text when tools are disabled', async t => {
  const output = envelope(null, [CALL]);
  const app = await fixture(t, [adapter(async () => output)]);
  for (const extra of [{}, { tools: [TOOL], tool_choice: 'none' }]) {
    const response = await app.post(basic(extra));
    assert.equal(response.status, 200);
    const choice = (await response.json()).choices[0];
    assert.equal(choice.finish_reason, 'stop');
    assert.deepEqual(choice.message, { role: 'assistant', content: output });
  }
});

test('honors named tool_choice and allows only the named function', async t => {
  let output = envelope(null, [CALL]);
  const app = await fixture(t, [adapter(async () => output)]);
  const tools = [TOOL, { type: 'function', function: { name: 'list_files', parameters: { type: 'object' } } }];
  const body = basic({ tools, tool_choice: { type: 'function', function: { name: 'read_file' } } });
  assert.equal((await app.post(body)).status, 200);
  output = envelope(null, [{ ...CALL, function: { name: 'list_files', arguments: {} } }]);
  assert.equal((await app.post(body)).status, 502);
});

test('does not expose upstream exception messages or credentials', async t => {
  const secret = 'SESSION_COOKIE=super-secret-provider-cookie';
  const app = await fixture(t, [adapter(async () => { throw new Error(secret); })]);
  const response = await app.post(basic());
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.equal(text.includes(secret), false);
  assert.equal(JSON.parse(text).error.code, 'provider_error');
});

test('preserves recognized website recovery codes and status without upstream text', async t => {
  const privateText = 'SESSION_COOKIE=private-fixture https://example.invalid/chat/private?token=private-fixture';
  let failure;
  const app = await fixture(t, [adapter(async () => { throw Object.assign(new Error(privateText), failure); })]);
  for (const [code, status, message] of [
    ['verification_required', 503, /manual security check/],
    ['authentication_required', 401, /sign in again/],
    ['rate_limited', 429, /limit.*reset/],
    ['draft_present', 409, /unsent draft/],
    ['new_chat_required', 503, /new empty chat/],
    ['incomplete_response', 502, /complete answer/],
    ['unsupported_response_format', 502, /unsupported response format/],
  ]) {
    failure = { code, status };
    const response = await app.post(basic({ stream: true }));
    assert.equal(response.status, status);
    const text = await response.text(), payload = JSON.parse(text);
    assert.equal(payload.error.code, code);
    assert.match(payload.error.message, message);
    assert.doesNotMatch(text, /private-fixture|example\.invalid|SESSION_COOKIE/);
  }
});

test('unknown or invalid adapter error metadata remains sanitized', async t => {
  let failure;
  const app = await fixture(t, [adapter(async () => { throw Object.assign(new Error('private-upstream-value'), failure); })]);
  for (const value of [{ code: 'private-upstream-value', status: 403 }, { code: '__proto__', status: 503 },
    { code: 'constructor', status: 503 }, { code: 'verification_required', status: 200 },
    { code: 'verification_required', status: '503' }, { code: 'verification_required', status: 600 }]) {
    failure = value;
    const response = await app.post(basic());
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.equal(JSON.parse(text).error.code, 'provider_error');
    assert.doesNotMatch(text, /private-upstream-value|__proto__|constructor/);
  }
});

test('serializes requests per provider while other configured providers continue', async t => {
  const started = deferred();
  const output = deferred();
  const app = await fixture(t, [adapter(async () => { started.resolve(); return output.promise; }), adapter(undefined, { id: 'zai', label: 'Z.ai', models: [{ id: 'zai-web' }] })]);
  const first = app.post(basic());
  await started.promise;
  const busy = await app.post(basic());
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).error.code, 'provider_busy');
  assert.equal((await (await app.get('/status')).json()).providers[0].busy, true);
  assert.equal((await app.post(basic({ model: 'zai-web' }))).status, 200);
  output.resolve('Completed');
  assert.equal((await first).status, 200);
  assert.equal((await (await app.get('/status')).json()).providers[0].busy, false);
});

test('timeouts abort downstream and return a JSON gateway timeout', async t => {
  const cancelled = deferred();
  const app = await fixture(t, [adapter(async (_request, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled.resolve(signal.reason); reject(signal.reason); }, { once: true });
  }))], { timeoutMs: 30 });
  const response = await app.post(basic({ stream: true }));
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'provider_timeout');
  assert.equal((await cancelled.promise).code, 'provider_timeout');
  assert.equal((await (await app.get('/status')).json()).providers[0].busy, false);
});

test('holds the provider lock after timeout until an uncooperative operation actually settles', async t => {
  const output = deferred();
  let signal;
  const app = await fixture(t, [adapter(async (_request, context) => { signal = context.signal; return output.promise; })], { timeoutMs: 30 });
  assert.equal((await app.post(basic())).status, 504);
  assert.equal(signal.aborted, true);
  assert.equal((await app.post(basic())).status, 409);
  output.resolve('Too late');
  await nextTurn();
  assert.equal((await app.post(basic())).status, 200);
});

test('client disconnection aborts the downstream provider request', async t => {
  const started = deferred();
  const cancelled = deferred();
  const app = await fixture(t, [adapter(async (_request, { signal }) => new Promise((resolve, reject) => {
    started.resolve();
    signal.addEventListener('abort', () => { cancelled.resolve(signal.reason); reject(signal.reason); }, { once: true });
  }))]);
  const client = http.request(`${app.url}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } });
  client.on('error', () => {});
  client.end(JSON.stringify(basic()));
  await started.promise;
  client.destroy();
  assert.equal((await cancelled.promise).code, 'client_disconnected');
  await nextTurn();
  assert.equal((await (await app.get('/status')).json()).providers[0].busy, false);
});

test('stop aborts active requests, closes the listener, and is idempotent', async t => {
  const started = deferred();
  const cancelled = deferred();
  const app = await fixture(t, [adapter(async (_request, { signal }) => new Promise((resolve, reject) => {
    started.resolve();
    signal.addEventListener('abort', () => { cancelled.resolve(signal.reason); reject(signal.reason); }, { once: true });
  }))]);
  assert.deepEqual(await app.service.start(), { host: app.host, port: app.port, url: app.url });
  const request = app.post(basic()).catch(() => null);
  await started.promise;
  await app.service.stop();
  assert.equal((await cancelled.promise).code, 'server_stopping');
  const response = await request;
  if (response) assert.equal(response.status, 503);
  await app.service.stop();
  await assert.rejects(() => app.service.start(), /cannot be restarted/);
  await assert.rejects(() => fetch(`${app.url}/health`));
});
