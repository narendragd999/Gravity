import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { Store } from '../electron/store.mjs';
import { ManagedBridges } from '../electron/managed-bridges.mjs';

const secret = 'fixture-bridge-access-secret';
const source = `
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const mode = process.argv[2];
const directory = process.env.FIXTURE_DIRECTORY;
fs.writeFileSync(path.join(directory, mode + '.json'), JSON.stringify({ pid: process.pid, args: process.argv.slice(3), cwd: process.cwd(), envCase: process.env.STUDIO_UNIVERSAL_BRIDGE_CASE_FIXTURE }));
if (mode === 'exit') process.exit(7);
if (mode === 'tree' || mode === 'branch') {
  const child = spawn(process.execPath, [__filename, mode === 'tree' ? 'branch' : 'server'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  setInterval(() => {}, 1000);
} else if (mode === 'wait') setInterval(() => {}, 1000);
else {
  const start = () => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer ' + process.env.FIXTURE_SECRET) { res.statusCode = 401; res.end('{}'); return; }
      if (req.url === '/health') { res.end('{"ok":true}'); return; }
      if (mode === 'missing-models') { res.statusCode = 404; res.end('{}'); return; }
      fs.writeFileSync(path.join(directory, 'request.json'), JSON.stringify({ url: req.url, authorization: req.headers.authorization }));
      res.end('{"data":[{"id":"fixture-model"}]}');
    });
    server.listen(Number(process.env.FIXTURE_PORT), '127.0.0.1');
    process.stdout.write('split ' + process.env.FIXTURE_SECRET.slice(0, 10));
    setTimeout(() => process.stdout.write(process.env.FIXTURE_SECRET.slice(10) + '\\n'), 10);
    setTimeout(() => console.log('Authorization: Bearer ' + process.env.FIXTURE_SECRET), 20);
  };
  if (mode === 'delayed') setTimeout(start, 1500); else start();
}
`;

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-universal-bridge-'));
  const key = randomBytes(32), file = path.join(directory, 'state.json');
  const crypto = {
    encrypt(text) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const ciphertext = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64'); },
    decrypt(text) { const data = Buffer.from(text, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString(); },
  };
  const store = new Store(file, crypto), managers = [], servers = [];
  t.after(async () => {
    for (const manager of managers) await manager.shutdown();
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directory, file, crypto, store,
    manager() { const manager = new ManagedBridges({ store }); managers.push(manager); return manager; },
    provider(baseUrl, overrides = {}) { return store.saveProvider({ name: 'Fixture provider', type: 'openai', baseUrl, models: ['fixture-model'], apiKey: secret, ...overrides }); },
    async server(handler) { const server = http.createServer(handler); servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }; },
  };
}

async function managedFixture(t, mode = 'server', overrides = {}) {
  const f = await fixture(t), port = await freePort(), script = path.join(f.directory, 'bridge fixture.cjs');
  await fs.writeFile(script, source);
  const provider = f.provider(`http://127.0.0.1:${port}/v1/chat/completions`);
  const profile = f.store.saveBridgeProfile({
    name: 'Managed fixture', providerId: provider.id, launchMode: 'managed', executable: process.execPath,
    args: [script, mode, 'literal spaces; & $ no shell'], cwd: f.directory, startupTimeoutMs: 5000,
    env: { FIXTURE_DIRECTORY: f.directory, FIXTURE_PORT: String(port), FIXTURE_SECRET: secret }, ...overrides,
  });
  return { ...f, port, script, provider, profile, manager: f.manager() };
}

async function until(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture condition.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

test('bridge profiles migrate legacy state, encrypt environment, and mask/preserve/clear saved values', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.store.publicState().bridgeProfiles, []);
  f.store.save(); const legacy = JSON.parse(await fs.readFile(f.file, 'utf8')); delete legacy.bridgeProfiles;
  await fs.writeFile(f.file, JSON.stringify(legacy));
  assert.deepEqual(new Store(f.file, f.crypto).publicState().bridgeProfiles, []);
  const provider = f.provider('https://bridge.example/v1');
  const input = { name: 'External Claude', providerId: provider.id, launchMode: 'external', env: { SESSION_TOKEN: 'fixture-session-secret', EMPTY: '' } };
  const saved = f.store.saveBridgeProfile(input);
  assert.deepEqual(saved.env, { SESSION_TOKEN: '********', EMPTY: '********' });
  assert.equal(saved.startupTimeoutMs, 30000);
  assert.doesNotMatch(await fs.readFile(f.file, 'utf8'), /fixture-session-secret/);
  assert.doesNotMatch(JSON.stringify(f.store.publicState()), /fixture-session-secret|encryptedEnv/);
  assert.equal(new Store(f.file, f.crypto).bridgeProfile(saved.id).env.SESSION_TOKEN, 'fixture-session-secret');
  f.store.saveBridgeProfile({ ...input, id: saved.id, env: undefined });
  f.store.saveBridgeProfile({ ...saved, env: { SESSION_TOKEN: '********', EMPTY: '********' } });
  assert.deepEqual(f.store.bridgeProfile(saved.id).env, { SESSION_TOKEN: 'fixture-session-secret', EMPTY: '' });
  f.store.saveBridgeProfile({ ...saved, env: {} });
  assert.deepEqual(f.store.bridgeProfile(saved.id).env, {});
  f.store.removeBridgeProfile(saved.id);
  assert.deepEqual(f.store.publicState().bridgeProfiles, []);
});

test('bridge profile validation is atomic and constrains executable, arguments, environment, URLs, and linked provider edits', async t => {
  const f = await fixture(t), provider = f.provider('http://127.0.0.1:8082/v1');
  const input = { name: 'Fixture', providerId: provider.id, launchMode: 'managed', executable: process.execPath };
  const saved = f.store.saveBridgeProfile(input), before = await fs.readFile(f.file, 'utf8');
  for (const invalid of [
    { launchMode: 'shell' }, { providerId: 'missing' }, { executable: 'node' }, { executable: '' }, { cwd: 'relative' },
    { args: 'node script.js' }, { args: ['bad\0argument'] }, { env: [] }, { env: { A: 2 } }, { env: { 'BAD-NAME': 'x' } }, { env: { A: '********' } },
    { healthUrl: 'http://localhost:8082/health' }, { healthUrl: 'http://127.0.0.1:8082/health?token=secret' },
    { startupTimeoutMs: 999 }, { startupTimeoutMs: 180001 },
  ]) assert.throws(() => f.store.saveBridgeProfile({ ...input, id: saved.id, ...invalid }));
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  assert.throws(() => f.store.saveProvider({ ...provider, baseUrl: 'https://remote.example/v1' }), /loopback/);
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  const externalProvider = f.provider('https://remote.example/v1');
  assert.throws(() => f.store.saveBridgeProfile({ ...input, providerId: externalProvider.id }), /loopback/);
  assert.doesNotThrow(() => f.store.saveBridgeProfile({ ...input, providerId: externalProvider.id, launchMode: 'external', executable: '', healthUrl: 'https://remote.example/health' }));
});

test('external start/check use provider authentication and normalized models endpoint; stop never kills the external service', async t => {
  const f = await fixture(t), requests = [];
  const { baseUrl } = await f.server((req, res) => { requests.push({ url: req.url, authorization: req.headers.authorization }); res.setHeader('content-type', 'application/json'); res.end('{"data":[{"id":"fixture-model"}]}'); });
  const provider = f.provider(`${baseUrl}/chat/completions`);
  const profile = f.store.saveBridgeProfile({ name: 'External', providerId: provider.id, launchMode: 'external' });
  const manager = f.manager();
  assert.equal((await manager.start(profile.id)).state, 'ready');
  assert.equal((await manager.check(profile.id)).running, true);
  assert.deepEqual(requests[0], { url: '/v1/models', authorization: `Bearer ${secret}` });
  await assert.rejects(manager.start(profile.id), /already/);
  assert.equal((await manager.stop(profile.id)).state, 'stopped');
  assert.equal((await fetch(`${baseUrl}/models`)).status, 200);
});

test('custom health probes use the linked protocol authentication and report unavailable model discovery clearly', async t => {
  const f = await fixture(t), requests = [];
  const { baseUrl } = await f.server((req, res) => {
    requests.push({ url: req.url, key: req.headers['x-api-key'], version: req.headers['anthropic-version'] });
    res.statusCode = req.url === '/health' ? 204 : 404; res.end();
  });
  const provider = f.provider(baseUrl, { type: 'anthropic' });
  const profile = f.store.saveBridgeProfile({ name: 'Anthropic bridge', providerId: provider.id, launchMode: 'external' });
  const manager = f.manager();
  await assert.rejects(manager.check(profile.id), /does not expose model discovery/);
  f.store.saveBridgeProfile({ ...profile, healthUrl: new URL('/health', baseUrl).href });
  assert.equal((await manager.start(profile.id)).state, 'ready');
  assert.deepEqual(requests.at(-1), { url: '/health', key: secret, version: '2023-06-01' });
});

test('managed executable starts with exact arguments, encrypted environment and cwd; log redaction spans stream chunks; restart works', { timeout: 15000 }, async t => {
  const f = await managedFixture(t);
  assert.equal((await f.manager.start(f.profile.id)).state, 'ready');
  const processInfo = JSON.parse(await fs.readFile(path.join(f.directory, 'server.json'), 'utf8'));
  assert.deepEqual(processInfo.args, ['literal spaces; & $ no shell']); assert.equal(processInfo.cwd, f.directory);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory, 'request.json'), 'utf8')), { url: '/v1/models', authorization: `Bearer ${secret}` });
  await until(() => f.manager.status()[0].logs.some(line => line.includes('split')));
  assert.doesNotMatch(JSON.stringify(f.manager.status()), /fixture-bridge-access-secret|bridge-access-secret/);
  await f.manager.stop(f.profile.id);
  await until(() => !isAlive(processInfo.pid));
  assert.equal((await f.manager.start(f.profile.id)).state, 'ready');
  assert.equal((await f.manager.stop(f.profile.id)).running, false);
});

test('managed startup refuses an occupied provider port without affecting that server', async t => {
  const f = await managedFixture(t), server = http.createServer((req, res) => res.end('external remains'));
  await new Promise(resolve => server.listen(f.port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  await assert.rejects(f.manager.start(f.profile.id), /port .* unavailable/i);
  assert.equal(fsSync.existsSync(path.join(f.directory, 'server.json')), false);
  assert.equal(await (await fetch(`http://127.0.0.1:${f.port}`)).text(), 'external remains');
});

test('concurrent profiles cannot both claim the same local port', { timeout: 10000 }, async t => {
  const f = await managedFixture(t);
  const second = f.store.saveBridgeProfile({ ...f.store.bridgeProfile(f.profile.id), id: undefined, name: 'Second fixture' });
  const results = await Promise.allSettled([f.manager.start(f.profile.id), f.manager.start(second.id)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /already reserved|unavailable/);
});

test('authentication failures stop managed startup promptly and are distinct from connectivity failures', { timeout: 10000 }, async t => {
  const f = await managedFixture(t);
  f.store.saveBridgeProfile({ ...f.profile, env: { ...f.profile.env, FIXTURE_SECRET: 'different-fixture-secret' } });
  await assert.rejects(f.manager.start(f.profile.id), /HTTP 401.*authentication/);
  assert.equal(f.manager.status()[0].running, false);
  assert.doesNotMatch(JSON.stringify(f.manager.status()), /different-fixture-secret/);
});

test('repeated short environment values cannot recursively expand log redaction', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  const { baseUrl } = await f.server((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"data":[]}'); });
  const provider = f.provider(baseUrl);
  const profile = f.store.saveBridgeProfile({ name: 'Bounded redaction', providerId: provider.id, launchMode: 'external', env: Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`VALUE_${index}`, 'e'])) });
  const manager = f.manager();
  const result = await manager.start(profile.id);
  assert.equal(result.state, 'ready');
  assert.ok(result.logs.every(line => line.length <= 1500));
});

test('Windows custom environment values override inherited names regardless of casing', { timeout: 10000, skip: process.platform !== 'win32' }, async t => {
  const name = 'STUDIO_UNIVERSAL_BRIDGE_CASE_FIXTURE', previous = process.env[name];
  process.env[name] = 'inherited-fixture-value';
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  const f = await managedFixture(t);
  f.store.saveBridgeProfile({ ...f.profile, env: { ...f.profile.env, [name.toLowerCase()]: 'chosen-fixture-value' } });
  await f.manager.start(f.profile.id);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, 'server.json'), 'utf8')).envCase, 'chosen-fixture-value');
});

test('duplicate managed start is rejected and cancellation cannot revive a pending startup', { timeout: 10000 }, async t => {
  const f = await managedFixture(t, 'delayed');
  const first = f.manager.start(f.profile.id).then(value => ({ value }), error => ({ error }));
  await assert.rejects(f.manager.start(f.profile.id), /already/);
  await until(() => fsSync.existsSync(path.join(f.directory, 'delayed.json')));
  const pid = JSON.parse(await fs.readFile(path.join(f.directory, 'delayed.json'), 'utf8')).pid;
  await f.manager.stop(f.profile.id);
  assert.match((await first).error.message, /stopped/);
  assert.equal(f.manager.status()[0].state, 'stopped');
  await until(() => !isAlive(pid));
});

test('managed startup timeout and early process exit leave no running process', { timeout: 10000 }, async t => {
  const f = await managedFixture(t, 'wait', { startupTimeoutMs: 1000 });
  await assert.rejects(f.manager.start(f.profile.id), /startup exceeded 1 seconds/);
  const pid = JSON.parse(await fs.readFile(path.join(f.directory, 'wait.json'), 'utf8')).pid;
  await until(() => !isAlive(pid)); assert.equal(f.manager.status()[0].running, false);
  f.store.saveBridgeProfile({ ...f.profile, args: [f.script, 'exit'] });
  await assert.rejects(f.manager.start(f.profile.id), /exited.*7/);
  assert.equal(f.manager.status()[0].state, 'error');
});

test('failed startup cancellation retains process ownership and its port reservation until cleanup succeeds', { timeout: 10000 }, async t => {
  const f = await managedFixture(t, 'wait');
  const pending = f.manager.start(f.profile.id).then(value => ({ value }), error => ({ error }));
  await until(() => fsSync.existsSync(path.join(f.directory, 'wait.json')));
  const pid = JSON.parse(await fs.readFile(path.join(f.directory, 'wait.json'), 'utf8')).pid;
  const terminate = f.manager.terminate;
  f.manager.terminate = async function (entry) {
    if (entry.id === f.profile.id) throw new Error('Fixture process cleanup failed');
    return terminate.call(this, entry);
  };
  try {
    await assert.rejects(f.manager.stop(f.profile.id), /Fixture process cleanup failed/);
    assert.match((await pending).error.message, /Fixture process cleanup failed/);
    assert.equal(f.manager.status()[0].state, 'error');
    assert.equal(f.manager.status()[0].running, true);
    assert.equal(f.manager.reservations.get(f.port), f.profile.id);
    assert.equal(isAlive(pid), true);
    const other = f.store.saveBridgeProfile({ ...f.store.bridgeProfile(f.profile.id), id: undefined, name: 'Competing fixture' });
    await assert.rejects(f.manager.start(other.id), /already reserved/);
  } finally {
    f.manager.terminate = terminate;
    await f.manager.stop(f.profile.id);
  }
  assert.equal(f.manager.reservations.has(f.port), false);
  assert.equal(f.manager.status()[0].state, 'stopped');
  await until(() => !isAlive(pid));
});

test('managed stop terminates its owned child and grandchild processes', { timeout: 15000 }, async t => {
  const f = await managedFixture(t, 'tree');
  await f.manager.start(f.profile.id);
  const pids = await Promise.all(['tree', 'branch', 'server'].map(async name => JSON.parse(await fs.readFile(path.join(f.directory, `${name}.json`), 'utf8')).pid));
  assert.equal(new Set(pids).size, 3); assert.ok(pids.every(isAlive));
  await f.manager.stop(f.profile.id);
  await until(() => pids.every(pid => !isAlive(pid)));
});

test('stopping an external probe cancels the pending request and shutdown tolerates removed stopped profiles', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  let seen; const reached = new Promise(resolve => { seen = resolve; });
  const { baseUrl } = await f.server((req, res) => { seen(); });
  const provider = f.provider(baseUrl), profile = f.store.saveBridgeProfile({ name: 'External', providerId: provider.id, launchMode: 'external' }), manager = f.manager();
  const pending = manager.check(profile.id).then(value => ({ value }), error => ({ error }));
  await reached; await manager.stop(profile.id);
  assert.match((await pending).error.message, /stopped/);
  assert.equal(manager.status()[0].running, false);
  f.store.removeBridgeProfile(profile.id);
  await manager.shutdown();
});
