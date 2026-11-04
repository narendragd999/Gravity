import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserConnector, BROWSER_SITES, CONNECTOR_PROTOCOL } from '../electron/browser-connector.mjs';
import { complete } from '../electron/providers.mjs';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const otherId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const origin = `chrome-extension://${extensionId}`;
const clientHeaders = { 'X-Connector-Protocol': String(CONNECTOR_PROTOCOL), 'X-Connector-Version': '1.0.5' };
const input = { model: 'claude-web', messages: [{ role: 'user', content: 'Hello from the test client.' }] };
const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a selected workspace file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];

async function until(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for browser connector fixture.');
    await delay(10);
  }
}

async function fixture(t, options = {}) {
  let apiToken, extensionToken;
  const connector = new BrowserConnector({ port: 0, onReady: info => { apiToken = info.token; }, ...options });
  t.after(() => connector.shutdown());
  const state = await connector.start();
  const base = state.url.replace(/\/v1$/, '');
  const request = (route, body, { token = apiToken, headers = {}, method = body === undefined ? 'GET' : 'POST', signal } = {}) => fetch(`${base}${route}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }), ...(signal ? { signal } : {}),
  });
  const extension = (route, body, options = {}) => request(route, body, { token: extensionToken, ...options, headers: { 'X-Connector-Extension-ID': extensionId, ...clientHeaders, ...options.headers } });
  async function pair({ withOrigin = false } = {}) {
    const nonce = randomBytes(32).toString('base64url');
    const headers = withOrigin ? { Origin: origin } : {};
    const pending = await extension('/connector/pair', { extensionId, nonce }, { token: null, headers });
    assert.equal(pending.status, 202);
    const data = await pending.json();
    const before = await extension('/connector/pair/status', { id: data.id, nonce }, { token: null, headers });
    assert.equal(before.status, 202); assert.deepEqual(await before.json(), { status: 'pending' });
    connector.approvePairing(data.id);
    const approved = await extension('/connector/pair/status', { id: data.id, nonce }, { token: null, headers });
    assert.equal(approved.status, 200);
    extensionToken = (await approved.json()).token;
    return { id: data.id, nonce, token: extensionToken };
  }
  const heartbeat = async (ids = ['claude']) => {
    const response = await extension('/connector/heartbeat', { sites: ids.map(id => ({ id, connected: true, busy: false })) });
    assert.equal(response.status, 200); return response.json();
  };
  const nextJob = () => until(async () => {
    const response = await extension('/connector/jobs'); assert.equal(response.status, 200);
    return (await response.json()).job;
  });
  return { connector, base, request, extension, pair, heartbeat, nextJob, get apiToken() { return apiToken; }, get extensionToken() { return extensionToken; } };
}

test('connector API and extension channels enforce independent tokens, strict website Origin rejection, host checks, and no cookies', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/v1/models', undefined, { token: null })).status, 401);
  assert.equal((await f.request('/v1/models', undefined, { headers: { Origin: 'https://example.test' } })).status, 403);
  assert.equal((await f.request('/v1/models', undefined, { headers: { Origin: origin } })).status, 403);
  assert.equal((await f.request('/v1/models', undefined, { headers: { 'X-Connector-Extension-ID': extensionId } })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = http.get(`${f.base}/v1/models`, { headers: { Host: 'untrusted.example', Authorization: `Bearer ${f.apiToken}` } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    request.once('error', reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await f.request('/v1/models', undefined, { headers: { Cookie: 'fixture=never-read' } })).status, 403);
  const list = await (await f.request('/v1/models')).json();
  assert.deepEqual(list.data.map(model => model.id), BROWSER_SITES.map(site => site.model));
  assert.equal((await f.request('/connector/jobs')).status, 403);
  await f.pair();
  assert.equal((await f.extension('/connector/jobs', undefined, { token: f.apiToken })).status, 401);
  assert.equal((await f.request('/v1/models', undefined, { token: f.extensionToken })).status, 401);
  assert.equal((await f.extension('/connector/jobs', undefined, { headers: { Origin: 'https://claude.ai' } })).status, 403);
  assert.equal((await f.extension('/connector/jobs', undefined, { headers: { Origin: 'null' } })).status, 403);
  assert.equal((await f.extension('/connector/jobs', undefined, { headers: { Origin: `chrome-extension://${otherId}` } })).status, 403);
  assert.equal((await f.extension('/connector/jobs', undefined, { headers: { 'X-Connector-Extension-ID': otherId } })).status, 403);
  assert.equal((await f.extension('/connector/jobs', undefined, { headers: { Origin: origin } })).status, 200);
  assert.equal((await f.extension('/connector/jobs')).status, 200, 'MV3 privileged fetch may omit Origin.');
  const publicText = JSON.stringify(f.connector.status());
  assert.ok(!publicText.includes(f.apiToken)); assert.ok(!publicText.includes(f.extensionToken));
});

test('pairing requires explicit desktop approval and the original nonce; CORS is limited to matching extension origins', async t => {
  const f = await fixture(t), nonce = randomBytes(32).toString('hex');
  const preflight = await f.extension('/connector/pair', undefined, { token: null, method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Headers': 'Authorization,Content-Type,X-Connector-Extension-ID,X-Connector-Protocol,X-Connector-Version' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.equal((await f.extension('/connector/pair', undefined, { token: null, method: 'OPTIONS', headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const response = await f.request('/connector/pair', { extensionId, nonce }, { token: null, headers: clientHeaders });
  assert.equal(response.status, 202, 'Origin-omitted initial pairing can supply its ID in the body.');
  const { id } = await response.json();
  assert.equal(f.connector.status().paired, false);
  assert.deepEqual(Object.keys(f.connector.status().pendingPairings[0]).sort(), ['createdAt', 'extensionId', 'id']);
  const wrong = await f.extension('/connector/pair/status', { id, nonce: randomBytes(32).toString('hex') }, { token: null });
  assert.equal(wrong.status, 404);
  const pending = await f.extension('/connector/pair/status', { id, nonce }, { token: null });
  assert.deepEqual(await pending.json(), { status: 'pending' });
  f.connector.approvePairing(id);
  const approved = await f.extension('/connector/pair/status', { id, nonce }, { token: null });
  const token = (await approved.json()).token; assert.ok(token.length >= 32);
  assert.ok(!JSON.stringify(f.connector.status()).includes(token));
  assert.ok(!JSON.stringify(f.connector.status()).includes(nonce));
  assert.equal((await f.extension('/connector/pair', { extensionId, nonce }, { token: null })).status, 409);
  f.connector.revoke();
  assert.equal((await f.extension('/connector/jobs', undefined, { token })).status, 403);
  assert.equal(f.connector.status().paired, false);
});

test('pairing expires, validates nonce and extension IDs, and bounds pending requests and attempts', async t => {
  const f = await fixture(t, { pairingTtlMs: 80 });
  const nonce = randomBytes(32).toString('hex');
  assert.equal((await f.extension('/connector/pair', { extensionId, nonce: 'short' }, { token: null })).status, 400);
  assert.equal((await f.extension('/connector/pair', { extensionId: otherId, nonce }, { token: null })).status, 400);
  assert.equal((await f.extension('/connector/pair', { extensionId, nonce, cookies: 'unsupported' }, { token: null })).status, 400);
  const { id } = await (await f.extension('/connector/pair', { extensionId, nonce }, { token: null })).json();
  await delay(110);
  assert.throws(() => f.connector.approvePairing(id), /expired/);
  assert.equal((await f.extension('/connector/pair/status', { id, nonce }, { token: null })).status, 404);
  const bounded = await fixture(t);
  const attempts = [];
  for (let index = 0; index < 7; index++) attempts.push((await bounded.extension('/connector/pair', { extensionId, nonce: randomBytes(32).toString('hex') }, { token: null })).status);
  assert.equal(attempts.filter(status => status === 202).length, 5);
  assert.equal(attempts.at(-1), 429);
  assert.ok(bounded.connector.status().pendingPairings.length <= 5);
});

test('legacy extensions are refused before pairing with visible upgrade guidance', async t => {
  const f = await fixture(t), nonce = randomBytes(32).toString('hex');
  const response = await f.request('/connector/pair', { extensionId, nonce }, { token: null, headers: { 'X-Connector-Version': '1.0.0' } });
  assert.equal(response.status, 426);
  assert.match((await response.json()).error.message, /Open extension setup.*reload/i);
  const state = f.connector.status();
  assert.equal(state.paired, false); assert.equal(state.pendingPairings.length, 0);
  assert.deepEqual(state.extension, { version: '1.0.0', protocol: null, compatible: false, error: state.error });
  const generation = await f.request('/v1/chat/completions', input);
  assert.equal(generation.status, 503);
  assert.match((await generation.json()).error.message, /extension is outdated or incompatible/);
  assert.equal(f.connector.jobs.size, 0);
  await f.pair();
  assert.equal(f.connector.status().extension.compatible, true);
  assert.equal(f.connector.status().error, undefined);
});

test('extension compatibility uses the protocol instead of an exact release version', async t => {
  const f = await fixture(t), nonce = randomBytes(32).toString('hex');
  for (const protocol of ['1', '2', '4', 'invalid']) {
    const response = await f.extension('/connector/pair', { extensionId, nonce }, { token: null, headers: { 'X-Connector-Protocol': protocol } });
    assert.equal(response.status, 426);
    assert.equal(f.connector.status().pendingPairings.length, 0);
  }
  const response = await f.extension('/connector/pair', { extensionId, nonce }, { token: null, headers: { 'X-Connector-Version': '9.2.3' } });
  assert.equal(response.status, 202);
  f.connector.approvePairing((await response.json()).id);
  assert.deepEqual(f.connector.status().extension, { version: '9.2.3', protocol: CONNECTOR_PROTOCOL, compatible: true });
});

test('a stale paired worker cannot receive queued prompts and a compatible heartbeat restores readiness', async t => {
  const f = await fixture(t); await f.pair(); await f.heartbeat();
  const pending = f.request('/v1/chat/completions', input);
  await until(() => f.connector.jobs.size === 1);
  const queued = [...f.connector.jobs.values()][0];
  const staleHeaders = { 'X-Connector-Extension-ID': extensionId, 'X-Connector-Version': '1.0.4', 'X-Connector-Protocol': '2' };
  const poll = await f.request('/connector/jobs', undefined, { token: f.extensionToken, headers: staleHeaders });
  assert.equal(poll.status, 426); assert.equal(queued.delivered, false);
  assert.equal((await pending).status, 503); assert.equal(f.connector.jobs.size, 0);
  assert.equal(f.connector.status().paired, true);
  assert.ok(f.connector.status().sites.every(site => !site.connected && !site.busy));
  const staleHeartbeat = await f.request('/connector/heartbeat', { sites: [{ id: 'claude', connected: true, busy: false }] }, { token: f.extensionToken, headers: staleHeaders });
  assert.equal(staleHeartbeat.status, 426);
  assert.equal(f.connector.status().extension.compatible, false);
  assert.ok(f.connector.status().sites.every(site => !site.connected));
  f.connector.pair.lastHeartbeat = Date.now() - f.connector.heartbeatTimeoutMs - 1;
  f.connector.sweep();
  assert.match(f.connector.status().error, /extension is outdated or incompatible/, 'Heartbeat loss must not erase the actionable upgrade error');
  const refreshed = await f.heartbeat(); assert.ok(refreshed.cancelledJobIds.includes(queued.id));
  assert.equal(f.connector.status().extension.compatible, true);
  assert.equal(f.connector.status().error, undefined);
  const retry = f.request('/v1/chat/completions', input), freshJob = await f.nextJob();
  assert.notEqual(freshJob.id, queued.id);
  await f.extension('/connector/results', { id: freshJob.id, siteId: freshJob.siteId, result: { content: 'Compatible extension answer.' } });
  assert.equal((await retry).status, 200);
});

test('an unauthenticated stale client cannot downgrade a paired extension status', async t => {
  const f = await fixture(t); await f.pair(); await f.heartbeat();
  const response = await f.request('/connector/jobs', undefined, { token: 'invalid-token', headers: { 'X-Connector-Extension-ID': extensionId } });
  assert.equal(response.status, 401);
  assert.equal(f.connector.status().extension.compatible, true);
  assert.equal(f.connector.status().sites.find(site => site.id === 'claude').connected, true);
});

test('generation validates exact website aliases and text input and refuses unpaired, disconnected, or busy sites', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/v1/chat/completions', input)).status, 503);
  await f.pair();
  assert.equal((await f.request('/v1/chat/completions', input)).status, 503);
  await f.heartbeat();
  for (const body of [
    { ...input, model: 'claude-made-up' },
    { ...input, messages: [] },
    { ...input, stream: 'true' },
    { ...input, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'https://example.test/a.png' }] }] },
    { ...input, tools: [{ type: 'function', function: { name: 123 } }] },
    { ...input, messages: [{ role: 'user', content: 'x'.repeat(100001) }] },
  ]) assert.ok([400, 404, 413].includes((await f.request('/v1/chat/completions', body)).status));
  assert.equal((await f.request('/v1/chat/completions', 'null')).status, 400);
  assert.equal((await f.request('/v1/chat/completions', '{broken')).status, 400);
  assert.equal((await f.request('/v1/chat/completions', input, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.extension('/connector/heartbeat', { sites: [{ id: 'unknown', connected: true, busy: false }] })).status, 400);
  assert.equal((await f.extension('/connector/heartbeat', { sites: [{ id: 'claude', connected: true, busy: true }] })).status, 200);
  assert.equal((await f.request('/v1/chat/completions', input)).status, 409);
  assert.equal(f.connector.jobs.size, 0);
});

test('a delivered job accepts only its own site and ID and produces a valid completion without exposing request content in status', async t => {
  const f = await fixture(t); await f.pair(); await f.heartbeat();
  const pending = f.request('/v1/chat/completions', input);
  await until(() => f.connector.jobs.size === 1);
  const queuedId = [...f.connector.jobs.keys()][0];
  assert.equal((await f.extension('/connector/results', { id: queuedId, siteId: 'claude', result: { content: 'Premature' } })).status, 409);
  const job = await f.nextJob();
  assert.equal(job.model, 'claude-web'); assert.equal(job.siteId, 'claude'); assert.deepEqual(job.messages, input.messages);
  assert.ok(!JSON.stringify(f.connector.status()).includes(input.messages[0].content));
  assert.equal((await f.extension('/connector/results', { id: 'wrong', siteId: 'claude', result: { content: 'Wrong' } })).status, 404);
  assert.equal((await f.extension('/connector/results', { id: job.id, siteId: 'chatgpt', result: { content: 'Wrong site' } })).status, 409);
  assert.equal(f.connector.jobs.size, 1);
  const accepted = await f.extension('/connector/results', { id: job.id, siteId: 'claude', result: { role: 'assistant', content: 'Fixture answer' } });
  assert.equal(accepted.status, 200);
  const response = await pending; assert.equal(response.status, 200);
  const completion = await response.json();
  assert.equal(completion.object, 'chat.completion'); assert.equal(completion.model, 'claude-web');
  assert.equal(completion.choices[0].message.content, 'Fixture answer');
  assert.equal(completion.choices[0].finish_reason, 'stop');
  assert.equal((await f.extension('/connector/results', { id: job.id, siteId: 'claude', result: { content: 'Replay' } })).status, 404);
  assert.equal(f.connector.status().sites.find(site => site.id === 'claude').busy, false);
});

test('buffered SSE tool results round-trip through the actual OpenAI-compatible provider adapter', async t => {
  const f = await fixture(t); await f.pair(); await f.heartbeat();
  const pending = complete({ type: 'openai', baseUrl: f.connector.status().url, apiKey: f.apiToken }, { ...input, tools, tool_choice: 'required', stream: true });
  const job = await f.nextJob();
  assert.equal(job.tools[0].function.name, 'read_file'); assert.equal(job.tool_choice, 'required');
  const call = { id: 'call_fixture', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } };
  const accepted = await f.extension('/connector/results', { id: job.id, siteId: job.siteId, result: { content: null, tool_calls: [call] } });
  assert.equal(accepted.status, 200);
  const response = await pending;
  assert.deepEqual(response.choices[0].message.tool_calls, [call]);
  assert.equal(response.choices[0].finish_reason, 'tool_calls');
});

test('empty responses, malformed tool arguments and unsolicited functions fail instead of becoming successful answers', async t => {
  const f = await fixture(t); await f.pair(); await f.heartbeat();
  const invalid = [
    { content: '   ' },
    { content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{broken' } }] },
    { content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'run_command', arguments: '{}' } }] },
    { role: 'user', content: 'Wrong role' },
  ];
  for (const result of invalid) {
    const pending = f.request('/v1/chat/completions', { ...input, tools });
    const job = await f.nextJob();
    const rejected = await f.extension('/connector/results', { id: job.id, siteId: job.siteId, result });
    assert.ok([400, 422].includes(rejected.status));
    const response = await pending; assert.equal(response.status, 502);
    assert.match((await response.json()).error.message, /Invalid website response/);
  }
});

test('website errors and heartbeat details redact runtime tokens and pairing nonces', async t => {
  const f = await fixture(t), pairing = await f.pair(); await f.heartbeat();
  const pending = f.request('/v1/chat/completions', input), job = await f.nextJob();
  const secrets = [f.apiToken, f.extensionToken, pairing.nonce];
  await f.extension('/connector/results', { id: job.id, siteId: job.siteId, error: `Fixture failure ${secrets.join(' ')}` });
  const response = await pending; assert.equal(response.status, 502);
  const report = JSON.stringify(await response.json()) + JSON.stringify(f.connector.status());
  for (const secret of secrets) assert.ok(!report.includes(secret));
  assert.match(report, /redacted/);
});

test('the bounded queue permits one request per site and completes all six independent sites', async t => {
  const f = await fixture(t); await f.pair(); await f.heartbeat(BROWSER_SITES.map(site => site.id));
  const pending = BROWSER_SITES.map(site => f.request('/v1/chat/completions', { ...input, model: site.model }));
  await until(() => f.connector.jobs.size === BROWSER_SITES.length);
  assert.equal((await f.request('/v1/chat/completions', input)).status, 409);
  const jobs = [];
  for (let index = 0; index < BROWSER_SITES.length; index++) jobs.push(await f.nextJob());
  assert.equal(new Set(jobs.map(job => job.siteId)).size, 6);
  assert.equal((await (await f.extension('/connector/jobs')).json()).job, null);
  for (const job of jobs) await f.extension('/connector/results', { id: job.id, siteId: job.siteId, result: { content: `Answer for ${job.siteId}` } });
  for (const response of await Promise.all(pending)) assert.equal(response.status, 200);
  assert.equal(f.connector.jobs.size, 0);
});

test('client cancellation releases its site and reports cancellation tombstones to the extension', async t => {
  const f = await fixture(t); await f.pair(); await f.heartbeat();
  const controller = new AbortController();
  const pending = f.request('/v1/chat/completions', input, { signal: controller.signal }).catch(() => null);
  const job = await f.nextJob(); controller.abort(); await pending;
  await until(() => f.connector.jobs.size === 0);
  const heartbeat = await f.heartbeat(); assert.ok(heartbeat.cancelledJobIds.includes(job.id));
  const poll = await (await f.extension('/connector/jobs')).json(); assert.ok(poll.cancelledJobIds.includes(job.id));
  assert.equal((await f.extension('/connector/results', { id: job.id, siteId: job.siteId, result: { content: 'Late answer' } })).status, 404);
});

test('timeouts and disconnected tabs return errors and cancel outstanding browser work', async t => {
  const f = await fixture(t, { requestTimeoutMs: 500 }); await f.pair(); await f.heartbeat();
  const timeout = f.request('/v1/chat/completions', input), first = await f.nextJob();
  const response = await timeout; assert.equal(response.status, 504); assert.match((await response.json()).error.message, /timeout/);
  assert.ok((await f.heartbeat()).cancelledJobIds.includes(first.id));
  const pending = f.request('/v1/chat/completions', input), second = await f.nextJob();
  const heartbeat = await f.extension('/connector/heartbeat', { sites: [] });
  assert.ok((await heartbeat.json()).cancelledJobIds.includes(second.id));
  assert.equal((await pending).status, 503);
  assert.equal(f.connector.jobs.size, 0);
});

test('heartbeat loss cancels jobs and a fresh heartbeat restores readiness without fabricating an answer', async t => {
  const f = await fixture(t, { heartbeatTimeoutMs: 500 }); await f.pair(); await f.heartbeat();
  const pending = f.request('/v1/chat/completions', input); await f.nextJob();
  const response = await pending; assert.equal(response.status, 503);
  assert.match((await response.json()).error.message, /disconnected/);
  assert.equal(f.connector.status().sites.some(site => site.connected), false);
  await f.heartbeat(); assert.equal(f.connector.status().sites.find(site => site.id === 'claude').connected, true);
});

test('revocation and stop cancel active requests, invalidate tokens, release the listener, and permit a clean restart', async t => {
  const f = await fixture(t); await f.pair(); await f.heartbeat();
  const first = f.request('/v1/chat/completions', input); await f.nextJob();
  f.connector.revoke(); assert.equal((await first).status, 503);
  assert.equal((await f.extension('/connector/jobs')).status, 403);
  await f.pair(); await f.heartbeat();
  const pending = f.request('/v1/chat/completions', input).then(response => response.text(), () => 'connection closed');
  await f.nextJob(); const oldToken = f.apiToken;
  await f.connector.stop(); await pending;
  assert.equal(f.connector.status().running, false); assert.equal(f.connector.jobs.size, 0);
  await assert.rejects(fetch(`${f.base}/v1/models`));
  const restarted = await f.connector.start();
  assert.equal(restarted.running, true); assert.equal(restarted.paired, false); assert.notEqual(f.apiToken, oldToken);
  const response = await fetch(`${restarted.url}/models`, { headers: { Authorization: `Bearer ${oldToken}` } });
  assert.equal(response.status, 401);
});

test('an in-flight heartbeat cannot restore pairing after revocation', async t => {
  const f = await fixture(t); await f.pair(); await f.heartbeat();
  const payload = JSON.stringify({ sites: [{ id: 'claude', connected: true, busy: false }] });
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(`${f.base}/connector/heartbeat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Connector-Extension-ID': extensionId, ...clientHeaders, Authorization: `Bearer ${f.extensionToken}` } }, res => { res.resume(); res.once('end', () => resolve(res)); });
    request.once('error', reject); request.write(payload.slice(0, 10));
  });
  await delay(30); f.connector.revoke(); request.end(payload.slice(10));
  assert.equal((await response).statusCode, 401);
  assert.equal(f.connector.status().paired, false); assert.ok(f.connector.status().sites.every(site => !site.connected));
});

test('overlapping starts share a listener and stopping during provider setup does not revive it', async t => {
  let entered, release;
  const setup = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const connector = new BrowserConnector({ port: 0, onReady: async () => { entered(); await wait; } });
  t.after(() => connector.stop());
  const first = connector.start().then(value => ({ value }), error => ({ error }));
  const second = connector.start().then(value => ({ value }), error => ({ error }));
  await setup; const server = connector.server;
  await connector.stop(); release();
  assert.match((await first).error.message, /cancelled/); assert.match((await second).error.message, /cancelled/);
  assert.equal(server.listening, false); assert.equal(connector.status().running, false);
});


test('raw website action transcripts fail without claiming that the current extension needs updating', async t => {
  const f = await fixture(t); await f.pair(); await f.heartbeat();
  const pending = f.request('/v1/chat/completions', { ...input, tools });
  const job = await f.nextJob();
  const rejected = await f.extension('/connector/results', { id: job.id, siteId: job.siteId, rawText: 'Claude responded: {"content":null,"toolcalls":[]}\n\n{“content”:null,”tool_calls”:[]}\n\njust now' });
  assert.equal(rejected.status, 422);
  const response = await pending;
  assert.equal(response.status, 502);
  const message = (await response.json()).error.message;
  assert.match(message, /No tool call was accepted/);
  assert.doesNotMatch(message, /extension.*updat|reload/i);
  assert.equal(f.connector.jobs.size, 0);
});

test('desktop decodes raw greetings once and preserves quoted action examples as text', async t => {
  const f = await fixture(t); await f.pair(); await f.heartbeat();
  const greeting = 'Hello! I’m Gravity, a coding agent working in your selected project folder.';
  const example = '{"content":null,"tool_calls":[{"id":"example","type":"function","function":{"name":"read_file","arguments":{"path":"README.md"}}}]}';
  for (const [rawText, expected] of [
    [JSON.stringify({ content: greeting, tool_calls: [] }), greeting],
    ['{“content”:“' + greeting + '”,“tool_calls”:[]}', greeting],
    ['```json\n{“tool_calls”:[],“content”:“' + greeting + '”}\n```', greeting],
    [JSON.stringify({ content: example, tool_calls: [] }), example],
    ['A normal final answer.', 'A normal final answer.'],
  ]) {
    const pending = f.request('/v1/chat/completions', { ...input, tools });
    const job = await f.nextJob();
    const accepted = await f.extension('/connector/results', { id: job.id, siteId: job.siteId, rawText });
    assert.equal(accepted.status, 200);
    const response = await pending; assert.equal(response.status, 200);
    const completion = await response.json();
    assert.deepEqual(completion.choices[0].message, { role: 'assistant', content: expected });
    assert.equal(completion.choices[0].finish_reason, 'stop');
  }
  const pending = f.request('/v1/chat/completions', { ...input, tools });
  const job = await f.nextJob();
  await f.extension('/connector/results', { id: job.id, siteId: job.siteId, result: { content: example } });
  assert.deepEqual((await (await pending).json()).choices[0].message, { role: 'assistant', content: example });
});

test('raw tool calls are validated and only strict complete envelopes become actions', async t => {
  const f = await fixture(t); await f.pair(); await f.heartbeat();
  const call = { id: 'read', type: 'function', function: { name: 'read_file', arguments: { path: 'README.md' } } };
  const pending = complete({ type: 'openai', baseUrl: f.connector.status().url, apiKey: f.apiToken }, { ...input, tools, tool_choice: 'required', stream: true });
  const job = await f.nextJob();
  assert.equal((await f.extension('/connector/results', { id: job.id, siteId: job.siteId, rawText: '```json\n' + JSON.stringify({ content: null, tool_calls: [call] }) + '\n```' })).status, 200);
  assert.deepEqual((await pending).choices[0].message.tool_calls, [{ ...call, function: { ...call.function, arguments: JSON.stringify(call.function.arguments) } }]);
  for (const [rawText, choice] of [
    ['{“content”:null,“tool_calls”:[{“function”:{“name”:“read_file”}}]}', 'auto'],
    [JSON.stringify({ content: null, tool_calls: [{ ...call, function: { name: 'run_command', arguments: {} } }] }), 'auto'],
    ['{“content”:“Hello”,“tool_calls”:[]}', 'required'],
    [42, 'auto'],
    ['x'.repeat(100001), 'auto'],
  ]) {
    const request = f.request('/v1/chat/completions', { ...input, tools, tool_choice: choice });
    const next = await f.nextJob();
    const rejected = await f.extension('/connector/results', { id: next.id, siteId: next.siteId, rawText });
    assert.ok([400, 422].includes(rejected.status));
    assert.equal((await request).status, 502);
    assert.equal(f.connector.jobs.size, 0);
  }
});

test('connector result payload variants are mutually exclusive', async t => {
  const f = await fixture(t); await f.pair(); await f.heartbeat();
  const pending = f.request('/v1/chat/completions', input), job = await f.nextJob();
  for (const payload of [{}, { rawText: 'Hello', result: { content: 'Hello' } }, { rawText: null, error: 'Failed' }, { result: null, error: null }]) {
    assert.equal((await f.extension('/connector/results', { id: job.id, siteId: job.siteId, ...payload })).status, 400);
    assert.equal(f.connector.jobs.size, 1);
  }
  await f.extension('/connector/results', { id: job.id, siteId: job.siteId, rawText: 'Hello' });
  assert.equal((await pending).status, 200);
});
