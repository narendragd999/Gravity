import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { GeminiBridge } from '../electron/bridge.mjs';

async function freePort() {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}

async function fixture(t, { health, onReady } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-bridge-test-'));
  const source = path.join(directory, 'source'); await fs.mkdir(source);
  const config = path.join(source, 'config.json');
  const original = { host: '0.0.0.0', api_keys: ['old-config-secret'], cookie_file: 'cookies.txt', log_requests: true, default_model: 'fixture-model' };
  await fs.writeFile(config, JSON.stringify(original));
  const servers = [], children = [], launches = [], ready = [];
  const bridge = new GeminiBridge({ directory: path.join(directory, 'managed'), onReady: async info => { ready.push(info); if (onReady) await onReady(info); } });
  const spawnMock = t.mock.method(childProcess, 'spawn', (executable, args, options) => {
    const runtime = JSON.parse(fsSync.readFileSync(args[1], 'utf8'));
    launches.push({ executable, args, options, runtime });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
    child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); return true; };
    children.push(child);
    const server = http.createServer((req, res) => {
      if (health) health(req, res, child);
      else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok' })); }
    }); servers.push(server); server.listen(runtime.port, runtime.host);
    return child;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    await bridge.stop(); spawnMock.mock.restore(); syncBuiltinESMExports();
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { bridge, source, config, original, launches, children, ready, start: port => bridge.start({ executable: process.execPath, config, port }) };
}

test('managed bridge creates a loopback/authenticated launch config without changing source credentials', async t => {
  const f = await fixture(t); const status = await f.start(await freePort());
  assert.equal(status.running, true); assert.equal(f.launches.length, 1);
  const launch = f.launches[0];
  assert.equal(launch.runtime.host, '127.0.0.1'); assert.equal(launch.runtime.log_requests, false);
  assert.equal(launch.runtime.cookie_file, path.join(f.source, 'cookies.txt'));
  assert.equal(launch.runtime.default_model, 'fixture-model'); assert.equal(launch.runtime.api_keys.length, 1);
  assert.ok(launch.runtime.api_keys[0].length >= 32); assert.notEqual(launch.runtime.api_keys[0], 'old-config-secret');
  assert.equal(launch.options.windowsHide, true); assert.equal(launch.options.cwd, f.source);
  assert.deepEqual(JSON.parse(await fs.readFile(f.config, 'utf8')), f.original);
  assert.equal(f.ready[0].token, launch.runtime.api_keys[0]);
  f.children[0].stdout.write(`old-config-secret ${launch.runtime.api_keys[0]} Authorization: Bearer secret\n`);
  assert.doesNotMatch(JSON.stringify(f.bridge.status()), new RegExp(`old-config-secret|${launch.runtime.api_keys[0]}|Bearer secret`));
  await f.bridge.stop(); assert.equal(f.bridge.status().running, false); assert.equal(f.children[0].exitCode, 0);
});

test('managed bridge refuses a used port without terminating the existing service', async t => {
  const f = await fixture(t); const existing = http.createServer((req, res) => res.end('existing'));
  await new Promise(resolve => existing.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { existing.closeAllConnections(); existing.close(resolve); }));
  const port = existing.address().port;
  await assert.rejects(f.start(port), /already in use/); assert.equal(f.launches.length, 0);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'existing');
});

test('managed bridge rejects overlapping start attempts before spawning a second process', async t => {
  const f = await fixture(t); const portA = await freePort(), portB = await freePort();
  const results = await Promise.allSettled([f.start(portA), f.start(portB)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(f.launches.length, 1);
});

test('managed bridge does not revive a stopped process when a pending health response succeeds', async t => {
  let reached; const requestSeen = new Promise(resolve => { reached = resolve; }); let respond;
  const f = await fixture(t, { health: (_, res) => { respond = () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok' })); }; reached(); } });
  const started = f.start(await freePort()).then(value => ({ value })).catch(error => ({ error }));
  await requestSeen; await f.bridge.stop(); respond();
  const result = await started;
  assert.ok(result.error, 'Stopped startup should reject.'); assert.equal(f.bridge.status().running, false); assert.equal(f.ready.length, 0);
});

test('managed bridge surfaces onReady configuration failure without a 90-second retry loop', { timeout: 5000 }, async t => {
  const f = await fixture(t, { onReady: () => { throw new Error('Secure storage failed in fixture'); } });
  await assert.rejects(f.start(await freePort()), /Secure storage failed in fixture/);
  assert.equal(f.bridge.status().running, false); assert.equal(f.ready.length, 1);
});
