import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { discoverModels } from '../electron/providers.mjs';
import { testProviderGeneration } from '../electron/provider-test.mjs';

const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const completion = content => ({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const providerAt = url => ({ id: 'test-provider', name: 'Local fixture', type: 'openai', baseUrl: `${url}/v1`, models: ['first-model'], defaultModel: 'default-model' });

async function fixture(t, handler) {
  const errors = [], requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method, url: req.url, body });
      await handler(req, res, body);
    } catch (error) { errors.push(error); json(res, { error: { message: error.message } }, 500); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (errors.length) throw errors[0];
  });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

test('successful model discovery does not make failed generation pass', async t => {
  const { url, requests } = await fixture(t, (req, res) => {
    if (req.method === 'GET') json(res, { data: [{ id: 'default-model' }, { id: 'other-model' }] });
    else json(res, { error: { message: 'Claude tab is not connected', code: 'tab_disconnected' } }, 503);
  });
  const provider = providerAt(url);
  assert.deepEqual(await discoverModels(provider), ['default-model', 'other-model']);
  const result = await testProviderGeneration(provider);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'tab_disconnected');
  assert.match(result.message, /Claude tab is not connected/);
  assert.match(result.message, /Local fixture \(default-model\)/);
  assert.deepEqual(requests.map(request => request.method), ['GET', 'POST']);
});

test('generation tests the selected model with only a bounded standalone prompt', async t => {
  const { url, requests } = await fixture(t, (_, res) => json(res, completion('OK')));
  const provider = { ...providerAt(url), systemPrompt: 'PRIVATE PROJECT CONTEXT', tools: [{ name: 'private_tool' }] };
  const result = await testProviderGeneration(provider, { model: ' selected-model ', messages: [{ role: 'system', content: 'PRIVATE HISTORY' }], tools: [{ name: 'read_file' }], project: '/private/project' });
  assert.equal(result.ok, true);
  assert.equal(result.providerId, provider.id);
  assert.equal(result.providerName, 'Local fixture');
  assert.equal(result.model, 'selected-model');
  assert.equal(result.endpoint, `${url}/v1/chat/completions`);
  assert.match(result.message, /Generation verified/);
  assert.doesNotMatch(result.message, /[Dd]iscover/);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { method: 'POST', url: '/v1/chat/completions', body: {
    model: 'selected-model', messages: [{ role: 'user', content: 'Reply with only OK.' }], max_tokens: 128, stream: false,
  } });
});

test('providers without model listing can pass with a saved model ID', async t => {
  const { url, requests } = await fixture(t, (req, res) => {
    if (req.method === 'GET') json(res, { error: { message: 'No model listing' } }, 404);
    else json(res, completion('OK'));
  });
  const provider = providerAt(url);
  await assert.rejects(discoverModels(provider), error => error.status === 404);
  assert.equal((await testProviderGeneration(provider)).ok, true);
  assert.equal(requests.at(-1).body.model, 'default-model');
  assert.equal(requests.filter(request => request.method === 'GET').length, 1);
  assert.equal((await testProviderGeneration({ ...provider, defaultModel: '' })).ok, true);
  assert.equal(requests.at(-1).body.model, 'first-model');
});

test('missing model is actionable and makes no network request', async t => {
  const { url, requests } = await fixture(t, (_, res) => json(res, completion('OK')));
  const result = await testProviderGeneration({ ...providerAt(url), defaultModel: '', models: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing_model');
  assert.equal(result.model, '');
  assert.match(result.message, /Enter a Model ID/);
  assert.equal(requests.length, 0);
});

test('empty or tool-only responses never verify text generation', async t => {
  let content;
  const { url } = await fixture(t, (_, res) => json(res, { choices: [{ message: { role: 'assistant', content, tool_calls: [{ id: 'call', type: 'function', function: { name: 'read_file', arguments: '{}' } }] } }] }));
  for (content of [null, '', ' \n\t', [{ type: 'text', text: '  ' }]]) {
    const result = await testProviderGeneration(providerAt(url));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'empty_response');
    assert.match(result.message, /Generation was not verified/);
  }
  content = [{ type: 'text', text: 'OK' }];
  assert.equal((await testProviderGeneration(providerAt(url))).ok, true);
});

test('generation test has a bounded timeout', async t => {
  const { url } = await fixture(t, () => {});
  const result = await testProviderGeneration(providerAt(url), { timeoutMs: 25 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'timeout');
  assert.match(result.message, /timed out/);
});

test('full completion URLs are normalized and test results redact secrets', async t => {
  const { url, requests } = await fixture(t, (_, res) => json(res, { error: { message: 'api-secret header-secret query-secret', code: 'api-secret' } }, 401));
  const provider = { ...providerAt(url), baseUrl: `${url}/v1/chat/completions/?token=query-secret`, apiKey: 'api-secret', headers: { 'x-tenant': 'header-secret' } };
  const result = await testProviderGeneration(provider);
  assert.equal(result.ok, false);
  assert.equal(result.endpoint, `${url}/v1/chat/completions`);
  assert.equal(requests[0].url, '/v1/chat/completions?token=query-secret');
  assert.doesNotMatch(JSON.stringify(result), /api-secret|header-secret|query-secret|\?token=/);
  assert.match(result.message, /\[redacted\]/);
});

test('browser readiness failures stop before sending any HTTP request', async t => {
  const { url, requests } = await fixture(t, (_, res) => json(res, completion('OK')));
  const provider = { ...providerAt(url), managedBy: 'browser-connector', defaultModel: 'claude-web', models: ['claude-web', 'chatgpt-web'] };
  const ready = { running: true, paired: true, sites: [{ id: 'claude', connected: true, busy: false }] };
  const cases = [
    [undefined, 'browser_not_running', /Start the Browser connector/],
    [{ ...ready, running: false }, 'browser_not_running', /Start the Browser connector/],
    [{ ...ready, error: 'Connector failed' }, 'browser_error', /Connector failed/],
    [{ ...ready, paired: false }, 'browser_not_paired', /Pair and approve/],
    [{ ...ready, sites: [{ id: 'chatgpt', connected: true, busy: false }] }, 'browser_site_not_connected', /sign in to Claude/],
    [{ ...ready, sites: [{ id: 'claude', connected: false, busy: false }] }, 'browser_site_not_connected', /connect its tab/],
    [{ ...ready, sites: [{ id: 'claude', connected: true, busy: true }] }, 'browser_site_busy', /Claude is busy/],
    [{ ...ready, sites: [{ id: 'claude', connected: true, busy: false, error: 'Sign-in required' }] }, 'browser_site_error', /Sign-in required/],
  ];
  for (const [browserStatus, code, message] of cases) {
    const result = await testProviderGeneration(provider, { browserStatus });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.match(result.message, message);
  }
  assert.equal((await testProviderGeneration(provider, { model: 'unsupported-model', browserStatus: ready })).code, 'browser_unknown_model');
  assert.equal(requests.length, 0);
  const result = await testProviderGeneration(provider, { browserStatus: ready });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'claude-web');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].body.model, 'claude-web');
});

test('browser readiness follows the selected website rather than another connected site', async t => {
  const { url, requests } = await fixture(t, (_, res) => json(res, completion('OK')));
  const provider = { ...providerAt(url), managedBy: 'browser-connector', defaultModel: 'claude-web' };
  const browserStatus = { running: true, paired: true, sites: [{ id: 'claude', connected: false, busy: false }, { id: 'chatgpt', connected: true, busy: false }] };
  const result = await testProviderGeneration(provider, { model: 'chatgpt-web', browserStatus });
  assert.equal(result.ok, true);
  assert.equal(requests[0].body.model, 'chatgpt-web');
});
