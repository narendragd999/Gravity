import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { discoverAccountModels } from '../bridges/multi-web2api/cli.mjs';
import { createWebApiServer } from '../bridges/multi-web2api/server.mjs';
import { createQwenAdapter } from '../bridges/multi-web2api/adapters/qwen.mjs';
import { createDeepSeekAdapter } from '../bridges/multi-web2api/adapters/deepseek.mjs';

const TOKEN = 'fixture-local-api-token-123456789';
const SECRET = 'private-session-token-must-not-be-reported';
const browser = () => ({ id: 'zai', label: 'Z.ai', models: [{ id: 'zai-web' }], complete: async () => 'Healthy account reply' });

test('failed direct discovery does not block healthy accounts or expose unavailable aliases', async t => {
  const qwen = createQwenAdapter({ token: SECRET, fetchImpl: async () => new Response(SECRET, { status: 401 }) });
  const deepseek = createDeepSeekAdapter({ token: SECRET, fetchImpl: async () => { throw new Error(SECRET); } });
  const zai = browser();
  let failedCompletions = 0;
  qwen.complete = deepseek.complete = async () => { failedCompletions++; return 'Must not run'; };
  const adapters = [qwen, deepseek, zai];
  assert.equal(await discoverAccountModels(adapters), adapters);
  assert.deepEqual(adapters.map(adapter => adapter.available), [false, false, true]);

  const service = createWebApiServer({ adapters, apiToken: TOKEN, port: 0 });
  t.after(() => service.stop());
  const { url } = await service.start();
  const headers = { Authorization: `Bearer ${TOKEN}` };
  assert.deepEqual(await (await fetch(`${url}/health`)).json(), { status: 'ok' });
  assert.equal((await fetch(`${url}/status`)).status, 401);
  const models = await (await fetch(`${url}/v1/models`, { headers })).json();
  assert.deepEqual(models.data.map(model => model.id), ['zai-web']);
  const statusText = await (await fetch(`${url}/status`, { headers })).text();
  assert.equal(statusText.includes(SECRET), false);
  const status = JSON.parse(statusText);
  for (const account of status.providers.slice(0, 2)) {
    assert.equal(account.available, false);
    assert.deepEqual(account.models, []);
    assert.equal(account.error.code, 'provider_unavailable');
    assert.match(account.error.message, /Sign in again.*restart/);
  }
  assert.deepEqual(status.providers[2].models, ['zai-web']);
  for (const model of ['qwen-web', 'deepseek-web', 'deepseek-web-thinking', 'zai-web']) {
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello fixture' }] }),
    });
    const text = await response.text();
    assert.equal(text.includes(SECRET), false);
    assert.equal(response.status, model === 'zai-web' ? 200 : 503);
    if (model === 'zai-web') assert.equal(JSON.parse(text).choices[0].message.content, 'Healthy account reply');
    else assert.equal(JSON.parse(text).error.code, 'provider_unavailable');
  }
  assert.equal(failedCompletions, 0);
});

test('all failed account discoveries give safe re-login guidance before startup', async () => {
  const adapters = [
    { ...browser(), id: 'qwen', discoverModels() { throw new Error(SECRET); } },
    { ...browser(), id: 'deepseek', async discoverModels() { throw Object.assign(new Error(SECRET), { code: SECRET }); } },
  ];
  await assert.rejects(discoverAccountModels(adapters), error => /providers are unavailable.*Sign in again.*restart/.test(error.message) && !error.message.includes(SECRET));
  assert.ok(adapters.every(adapter => adapter.available === false));
});

test('successful discovery clears a previous unavailable state', async () => {
  const adapter = { ...browser(), available: false, async discoverModels() { this.models = [{ id: 'recovered-web' }]; } };
  await discoverAccountModels([adapter]);
  assert.equal(adapter.available, true);
  assert.deepEqual(adapter.models, [{ id: 'recovered-web' }]);
});

test('discovery propagates pre-existing and active caller cancellation without stale availability updates', async () => {
  const reason = new Error('Fixture cancelled');
  const alreadyAborted = new AbortController();
  alreadyAborted.abort(reason);
  let calls = 0;
  await assert.rejects(discoverAccountModels([{ discoverModels() { calls++; } }], alreadyAborted.signal), error => error === reason);
  assert.equal(calls, 0);

  const controller = new AbortController();
  const adapter = { ...browser(), discoverModels({ signal }) {
    assert.equal(signal, controller.signal);
    return new Promise(() => {}); // Cancellation must also work with an uncooperative adapter.
  } };
  const pending = discoverAccountModels([adapter], controller.signal);
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(adapter.available, undefined);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
