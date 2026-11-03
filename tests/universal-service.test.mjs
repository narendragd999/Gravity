import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { UniversalService, loadUniversalConfig } from '../electron/universal-service.mjs';

const token = 'universal-gateway-test-token';
const environment = { GATEWAY_TOKEN: token, PROVIDER_KEY: 'fixture-provider-private-key', ANTHROPIC_KEY: 'fixture-anthropic-private-key', CUSTOM_HEADER: 'fixture-header-private-value', BRIDGE_KEY: 'fixture-bridge-private-key' };
const provider = (id = 'local', baseUrl = 'http://127.0.0.1:18741/v1') => ({ id, name: id, type: 'openai', baseUrl, models: ['fixture-model'], defaultModel: 'fixture-model' });
const config = (providers = [provider()], bridges = []) => ({ port: 0, providers, bridges });
const completion = content => ({ id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const servicesByTest = new WeakMap();

function trackService(t, service) {
  const services = servicesByTest.get(t) ?? []; services.push(service); servicesByTest.set(t, services);
  t.after(() => service.stop()); return service;
}

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-universal-test-'));
  t.after(async () => { for (const service of servicesByTest.get(t) ?? []) await service.stop(); await fs.rm(directory, { recursive: true, force: true }); }); return directory;
}
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function server(t, handler) {
  const errors = [];
  const instance = http.createServer(async (req, res) => {
    try { let raw = ''; for await (const part of req) raw += part; await handler(req, res, raw ? JSON.parse(raw) : undefined); }
    catch (error) { errors.push(error); res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(async () => { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); if (errors.length) throw errors[0]; });
  return `http://127.0.0.1:${instance.address().port}`;
}
async function request(service, model) {
  const response = await fetch(`${service.status().gateway.url}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello fixture' }] }) });
  assert.equal(response.status, 200); return response.json();
}
function serviceFor(t, input, options = {}) {
  const service = new UniversalService(input, { env: environment, ...options });
  return trackService(t, service);
}

async function managedFixture(t) {
  const directory = await temporary(t), port = await freePort();
  await fs.mkdir(path.join(directory, 'adapter'));
  const script = path.join(directory, 'adapter', 'fixture.mjs');
  await fs.writeFile(script, `import http from 'node:http';
const server = http.createServer(async (req,res) => {
  let raw=''; for await (const part of req) raw+=part;
  res.setHeader('content-type','application/json');
  if (req.url === '/health') { res.end(JSON.stringify({pid:process.pid,cwd:process.cwd(),argument:process.argv[3]})); return; }
  if (req.headers.authorization !== 'Bearer '+process.env.SERVICE_KEY) { res.writeHead(401); res.end('{}'); return; }
  if (req.url === '/v1/models') { res.end(JSON.stringify({data:[{id:'fixture-model'}]})); return; }
  if (req.url === '/v1/chat/completions') { res.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:'fixture-model',choices:[{index:0,message:{role:'assistant',content:'Managed fixture responded.'},finish_reason:'stop'}]})); return; }
  res.writeHead(404); res.end('{}');
});
server.listen(Number(process.argv[2]),'127.0.0.1',()=>console.log('Fixture token: '+process.env.SERVICE_KEY));
`);
  const p = { ...provider('managed', `http://127.0.0.1:${port}/v1`), apiKeyEnv: 'BRIDGE_KEY' };
  const bridge = { id: 'managed-process', name: 'Local fixture process', providerId: p.id, launchMode: 'managed', executable: process.execPath,
    args: [script, String(port), 'one exact argument & symbols'], cwd: 'adapter', healthUrl: `http://127.0.0.1:${port}/health`, startupTimeoutMs: 10000,
    env: { FIXTURE_MODE: 'nonsecret-value' }, envFrom: { SERVICE_KEY: 'BRIDGE_KEY' } };
  return { directory, port, script, provider: p, bridge, config: config([p], [bridge]) };
}

test('universal service routes multiple configured protocols and keeps existing gateway configs compatible', async t => {
  const openUrl = await server(t, (req, res, body) => {
    assert.equal(req.headers.authorization, `Bearer ${environment.PROVIDER_KEY}`);
    assert.equal(req.headers['x-fixture'], environment.CUSTOM_HEADER);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') { assert.equal(req.url, '/custom/v1/models'); res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); }
    else { assert.equal(req.url, '/custom/v1/chat/completions'); assert.equal(body.model, 'fixture-model'); res.end(JSON.stringify(completion('OpenAI fixture'))); }
  });
  const anthropicUrl = await server(t, (req, res, body) => {
    assert.equal(req.headers['x-api-key'], environment.ANTHROPIC_KEY); res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') { assert.equal(req.url, '/v1/models'); res.end(JSON.stringify({ data: [{ id: 'fixture-model' }], has_more: false })); }
    else { assert.equal(req.url, '/v1/messages'); assert.equal(body.model, 'fixture-model'); res.end(JSON.stringify({ id: 'anthropic-fixture', type: 'message', role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text: 'Anthropic fixture' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } })); }
  });
  const providers = [{ ...provider('open', `${openUrl}/custom/v1`), apiKeyEnv: 'PROVIDER_KEY', headerEnv: { 'x-fixture': 'CUSTOM_HEADER' } }, { ...provider('anthropic', `${anthropicUrl}/v1`), type: 'anthropic', apiKeyEnv: 'ANTHROPIC_KEY' }];
  const bridges = providers.map(p => ({ id: `${p.id}-external`, name: p.id, providerId: p.id, launchMode: 'external' }));
  const service = serviceFor(t, config(providers, bridges)); await service.start();
  assert.equal((await request(service, 'open/fixture-model')).choices[0].message.content, 'OpenAI fixture');
  assert.equal((await request(service, 'anthropic/fixture-model')).choices[0].message.content, 'Anthropic fixture');
  assert.ok(service.status().bridges.every(bridge => bridge.state === 'ready'));
  const listed = await (await fetch(`${service.status().gateway.url}/models`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(listed.data.map(m => m.id), ['open/fixture-model', 'anthropic/fixture-model']);
  await service.stop();
  assert.equal((await fetch(`${openUrl}/custom/v1/models`, { headers: { authorization: `Bearer ${environment.PROVIDER_KEY}`, 'x-fixture': environment.CUSTOM_HEADER } })).status, 200, 'External service must remain alive.');
  const legacy = serviceFor(t, { port: 0, providers }); await legacy.start(); assert.equal(legacy.status().bridges.length, 0);
  assert.equal((await request(legacy, 'open/fixture-model')).choices[0].message.content, 'OpenAI fixture');
});

test('universal service launches an exact configured command, injects env references, and terminates its owned process', async t => {
  const f = await managedFixture(t);
  const configFile = path.join(f.directory, 'universal.json'); const original = JSON.stringify(f.config, null, 2); await fs.writeFile(configFile, original);
  const observed = [];
  const service = trackService(t, await loadUniversalConfig(configFile, { env: environment, onChange: status => observed.push(status) }));
  const before = (await fs.readdir(f.directory, { recursive: true })).sort();
  await service.start();
  const health = await (await fetch(`http://127.0.0.1:${f.port}/health`)).json();
  assert.equal(health.cwd.toLowerCase(), path.join(f.directory, 'adapter').toLowerCase()); assert.equal(health.argument, 'one exact argument & symbols');
  assert.equal((await request(service, 'managed/fixture-model')).choices[0].message.content, 'Managed fixture responded.');
  assert.equal(await fs.readFile(configFile, 'utf8'), original);
  assert.deepEqual((await fs.readdir(f.directory, { recursive: true })).sort(), before, 'Service must not write decrypted state or credentials.');
  await delay(30);
  for (const secret of Object.values(environment)) assert.equal(JSON.stringify([service.status(), observed]).includes(secret), false);
  await service.stop(); await assert.rejects(fetch(`http://127.0.0.1:${f.port}/health`));
  assert.throws(() => process.kill(health.pid, 0), 'The owned process should have exited.');
  assert.equal(service.status().state, 'stopped');
});

test('universal startup failure rolls back previously started bridges without starting its gateway', async t => {
  const f = await managedFixture(t), unavailablePort = await freePort();
  const missing = provider('missing', `http://127.0.0.1:${unavailablePort}/v1`);
  const failing = { id: 'missing-external', name: 'Unreachable local fixture', providerId: missing.id, launchMode: 'external', healthUrl: `http://127.0.0.1:${unavailablePort}/health`, startupTimeoutMs: 1000 };
  const service = serviceFor(t, config([f.provider, missing], [f.bridge, failing]), { configDirectory: f.directory });
  await assert.rejects(service.start(), /health endpoint|reach/);
  assert.equal(service.status().gateway.running, false);
  assert.ok(service.status().bridges.every(bridge => !bridge.running));
  await assert.rejects(fetch(`http://127.0.0.1:${f.port}/health`));
  assert.equal(service.status().state, 'error');
});

test('gateway bind failure rolls back managed bridges and preserves the unrelated port owner', async t => {
  const f = await managedFixture(t);
  const existing = await server(t, (_, res) => res.end('unrelated service'));
  const service = serviceFor(t, { ...f.config, port: Number(new URL(existing).port) }, { configDirectory: f.directory });
  await assert.rejects(service.start(), /EADDRINUSE|address already in use/i);
  assert.equal(service.status().gateway.running, false);
  await assert.rejects(fetch(`http://127.0.0.1:${f.port}/health`));
  assert.equal(await (await fetch(existing)).text(), 'unrelated service');
});

test('universal service can stop during startup and restart cleanly after a normal stop', async t => {
  const f = await managedFixture(t);
  const service = serviceFor(t, f.config, { configDirectory: f.directory });
  const pending = service.start(); const stop = service.stop();
  await assert.rejects(pending, /cancel|stopp/i); await stop;
  assert.equal(service.status().state, 'stopped'); assert.equal(service.status().gateway.running, false);
  await service.start(); assert.equal(service.status().state, 'running'); await service.stop();
  await service.start(); assert.equal((await request(service, 'managed/fixture-model')).choices[0].message.content, 'Managed fixture responded.');
});

test('universal service validates credential references, duplicates, protocols, URLs, and headers before any launch', t => {
  const build = (input, env = environment) => new UniversalService(input, { env });
  assert.throws(() => build(config(), {}), /GATEWAY_TOKEN/);
  assert.throws(() => build(config([{ ...provider(), apiKeyEnv: 'MISSING_KEY' }])), /MISSING_KEY/);
  assert.throws(() => build(config([{ ...provider(), apiKey: 'must-not-be-stored' }])), /unsupported field/);
  assert.throws(() => build(config([provider(), provider()])), /unique/);
  for (const change of [{ type: 'unsupported' }, { id: '../escape' }, { models: 'not-an-array' }, { baseUrl: 'file:///private' }, { baseUrl: 'https://user:secret@example.com/v1' }, { baseUrl: 'https://example.com/v1?api_key=secret' }, { headers: { Cookie: 'secret' } }, { headers: { authorization: 'secret' } }, { headers: { 'x-value': 'line\nbreak' } }, { headerEnv: { Cookie: 'BRIDGE_KEY' } }, { headers: { 'X-Fixture': 'literal' }, headerEnv: { 'x-fixture': 'CUSTOM_HEADER' } }]) assert.throws(() => build(config([{ ...provider(), ...change }])));
  assert.throws(() => build({ ...config(), port: 80 }), /Gateway port/);
  const profile = { id: 'bridge', name: 'Fixture', providerId: 'local', launchMode: 'managed', executable: process.execPath };
  for (const change of [{ providerId: 'unknown' }, { executable: 'node.exe' }, { args: 'not-an-array' }, { healthUrl: 'https://other.example/health' }, { envFrom: { SERVICE_KEY: 'MISSING_KEY' } }, { env: { API_KEY: 'literal-secret' } }, { env: { NAME: 'literal' }, envFrom: { NAME: 'PROVIDER_KEY' } }, { enabled: 'false' }]) assert.throws(() => build(config([provider()], [{ ...profile, ...change }])));
  assert.throws(() => build(config([provider('local', 'https://remote.example/v1')], [profile])), /loopback/);
  assert.throws(() => build(config([provider()], [profile, { ...profile }])), /Bridge IDs/);
  assert.throws(() => build(config([provider()], [profile, { ...profile, id: 'second' }])), /one enabled bridge/);
});

test('disabled managed profiles are validated but require no envFrom secrets or installed executable', async t => {
  const profile = { id: 'template', name: 'Optional fixture adapter', providerId: 'local', launchMode: 'managed', executable: path.join(os.tmpdir(), 'not-installed-fixture.exe'), enabled: false, envFrom: { SERVICE_KEY: 'MISSING_KEY' } };
  const service = serviceFor(t, config([provider()], [profile])); await service.start();
  assert.equal(service.status().bridges.length, 0); assert.equal(service.status().gateway.running, true);
});

test('configuration loader reports malformed JSON without echoing its content', async t => {
  const directory = await temporary(t), file = path.join(directory, 'bad.json');
  await fs.writeFile(file, '{"sensitive":"do-not-print-this", invalid}');
  await assert.rejects(loadUniversalConfig(file, { env: environment }), error => error.message === 'Service configuration must contain valid JSON.');
});

test('universal redaction is bounded, single-pass, and stable with repeated short secrets', t => {
  const service = serviceFor(t, config([{ ...provider(), apiKeyEnv: 'SHORT', headerEnv: { 'x-first': 'SHORT', 'x-second': 'METACHARS' } }]), { env: { ...environment, SHORT: 'a', METACHARS: '.*+?secret' } });
  assert.equal(service.redact('a a .*+?secret'), '[redacted] [redacted] [redacted]');
  assert.equal(service.redact('[redacted]'), '[redacted]');
  assert.ok(service.redact('a'.repeat(100000)).length <= 3000);
});

test('universal restart keeps the old manager when cleanup of an owned process fails', async t => {
  const f = await managedFixture(t); const service = serviceFor(t, f.config, { configDirectory: f.directory });
  await service.start();
  const manager = service.bridges, shutdown = manager.shutdown;
  manager.shutdown = async () => { manager.closing = true; throw new Error('Fixture termination failed'); };
  try {
    await assert.rejects(service.stop(), /Fixture termination failed/);
    await assert.rejects(service.start(), /cleanup is incomplete/);
    assert.equal(service.bridges, manager, 'Live ownership must not be discarded.');
    assert.equal((await fetch(`http://127.0.0.1:${f.port}/health`)).status, 200);
  } finally { manager.shutdown = shutdown; await service.stop(); }
  await assert.rejects(fetch(`http://127.0.0.1:${f.port}/health`));
});
