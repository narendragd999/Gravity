import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Gateway } from '../electron/gateway.mjs';

const token = 'test-gateway-token-123456';
const input = { model: 'model-a', messages: [{ role: 'user', content: 'Hello' }] };
const answer = text => ({ id: 'answer', object: 'chat.completion', created: 1, model: 'model-a', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
const chunk = (delta, finish_reason = null) => ({ id: 'answer', object: 'chat.completion.chunk', created: 1, model: 'model-a', choices: [{ index: 0, delta, finish_reason }] });

async function fixture(t, handler) {
  const errors = [];
  const upstream = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const part of req) raw += part;
      await handler(req, res, raw ? JSON.parse(raw) : null);
    } catch (error) { errors.push(error); res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const providers = [{ id: 'one', name: 'First', type: 'openai', baseUrl: `http://127.0.0.1:${upstream.address().port}/custom/v1`, models: ['model-a'], defaultModel: 'model-a', apiKey: 'upstream-only-key' }];
  const gateway = new Gateway({ getProviders: () => providers, getProvider: id => providers.find(p => p.id === id) });
  const status = await gateway.start({ port: 0, token });
  const origin = status.url.replace(/\/v1$/, '');
  const request = (path, body, headers = {}) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  t.after(async () => {
    await gateway.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    if (errors.length) throw errors[0];
  });
  return { gateway, providers, request, origin, upstream };
}

test('gateway authenticates routes, rejects browser origins, and lists namespaced model IDs', async t => {
  const { request } = await fixture(t, () => assert.fail('No upstream request expected.'));
  assert.equal((await request('/health', undefined, { authorization: '' })).status, 200);
  assert.equal((await request('/v1/models', undefined, { authorization: '' })).status, 401);
  assert.equal((await request('/v1/models', undefined, { authorization: 'Bearer incorrect-key' })).status, 401);
  assert.equal((await request('/v1/models', undefined, { origin: 'https://untrusted.example' })).status, 403);
  const list = await (await request('/v1/models')).json();
  assert.equal(list.data[0].id, 'one/model-a');
  assert.equal(JSON.stringify(list).includes('upstream-only-key'), false);
  assert.equal((await request('/not-found')).status, 404);
});

test('gateway forwards model aliases and custom IDs to configured base URL with upstream auth', async t => {
  const received = [];
  const { request } = await fixture(t, (req, res, body) => {
    assert.equal(req.url, '/custom/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer upstream-only-key');
    assert.equal(body.provider_id, undefined); received.push(body.model);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(answer(body.model)));
  });
  for (const body of [input, { ...input, model: 'one/model-a' }, { ...input, model: 'custom-not-in-registry', provider_id: 'one' }]) {
    const response = await request('/v1/chat/completions', body); assert.equal(response.status, 200);
    assert.ok((await response.json()).choices[0].message.content);
  }
  assert.deepEqual(received, ['model-a', 'model-a', 'custom-not-in-registry']);
});

test('gateway streams content and tool calls with final DONE event', async t => {
  const { request } = await fixture(t, (req, res, body) => {
    assert.equal(body.stream, true); res.setHeader('content-type', 'text/event-stream');
    for (const value of [chunk({ content: 'Streaming ' }), chunk({ content: 'reply' }), chunk({ tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] }), chunk({}, 'tool_calls')]) res.write(`data: ${JSON.stringify(value)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const response = await request('/v1/chat/completions', { ...input, stream: true });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const stream = await response.text(); assert.match(stream, /Streaming /); assert.match(stream, /read_file/); assert.match(stream, /data: \[DONE\]\n\n$/);
});

test('gateway rejects malformed JSON, missing messages, unknown model, and recursive gateway endpoint', async t => {
  const { request, providers, gateway } = await fixture(t, () => assert.fail('No upstream request expected.'));
  assert.equal((await request('/v1/chat/completions', '{broken')).status, 400);
  assert.equal((await request('/v1/chat/completions', { ...input, messages: [] })).status, 400);
  assert.equal((await request('/v1/chat/completions', { ...input, model: 'unknown' })).status, 404);
  providers[0].baseUrl = gateway.status().url;
  const response = await request('/v1/chat/completions', input); assert.equal(response.status, 400); assert.match((await response.json()).error.message, /points back/);
});

test('gateway returns provider errors without exposing credentials', async t => {
  const { request } = await fixture(t, (req, res) => { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Quota for upstream-only-key is exhausted.' } })); });
  const response = await request('/v1/chat/completions', input); assert.equal(response.status, 429);
  const message = (await response.json()).error.message; assert.match(message, /Quota/); assert.doesNotMatch(message, /upstream-only-key/);
});

test('gateway shutdown cancels an in-flight request and releases listening port', async t => {
  let seen; const reached = new Promise(resolve => { seen = resolve; });
  const { request, gateway, origin } = await fixture(t, () => seen());
  const pending = request('/v1/chat/completions', input).then(response => response.text()).catch(() => 'connection closed');
  await reached; await gateway.stop(); await pending;
  assert.equal(gateway.status().running, false);
  for (let i = 0; i < 20 && gateway.controllers.size; i++) await delay(10);
  assert.equal(gateway.controllers.size, 0);
  await assert.rejects(fetch(`${origin}/health`));
});

test('gateway validates JSON object and routing field types as client errors', async t => {
  const { request } = await fixture(t, () => assert.fail('Invalid input must not reach a provider.'));
  for (const body of ['null', '[]', { ...input, model: 123 }, { ...input, model: {} }, { ...input, provider_id: 10 }, { ...input, stream: 'yes' }]) {
    const response = await request('/v1/chat/completions', body); assert.equal(response.status, 400, JSON.stringify(body));
  }
});

test('gateway does not silently substitute an unknown explicitly selected provider', async t => {
  const { request } = await fixture(t, () => assert.fail('Unknown explicit provider must not reach another provider.'));
  assert.equal((await request('/v1/chat/completions', { ...input, provider_id: 'missing-provider' })).status, 404);
});

test('gateway normalizes a model namespace when provider_id is also supplied', async t => {
  const { request } = await fixture(t, (_, res, body) => {
    assert.equal(body.model, 'model-a'); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(answer('ok')));
  });
  const response = await request('/v1/chat/completions', { ...input, model: 'one/model-a', provider_id: 'one' }); assert.equal(response.status, 200);
});

test('gateway never leaves an orphan listener after overlapping starts', async t => {
  const servers = [];
  const originalCreate = http.createServer;
  t.mock.method(http, 'createServer', (...args) => { const server = originalCreate(...args); servers.push(server); return server; });
  const gateway = new Gateway({ getProviders: () => [], getProvider: () => null });
  t.after(async () => {
    await gateway.stop();
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  const results = await Promise.allSettled([gateway.start({ port: 0, token }), gateway.start({ port: 0, token })]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  assert.equal(servers.length, 1, 'At most one listening server should be allocated.');
  await gateway.stop(); assert.ok(servers.every(server => !server.listening));
});

test('gateway contains an unexpected route failure and remains available', async t => {
  const { request, providers } = await fixture(t, () => assert.fail('No upstream request expected.'));
  providers[0].models = null;
  const response = await request('/v1/models'); assert.equal(response.status, 500);
  assert.equal((await response.json()).error.message, 'Gateway request failed.');
  assert.equal((await request('/health')).status, 200);
});
