import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { Store } from '../electron/store.mjs';
import { BrowserConnector, CONNECTOR_PROTOCOL } from '../electron/browser-connector.mjs';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const headers = { 'content-type': 'application/json', 'x-connector-extension-id': extensionId, 'x-connector-protocol': String(CONNECTOR_PROTOCOL), 'x-connector-version': '1.0.5' };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gravity-browser-pairing-'));
  const key = randomBytes(32), connectors = [];
  const crypto = {
    encrypt(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    },
    decrypt(value) {
      const data = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
  const file = path.join(directory, 'state.json');
  const store = new Store(file, crypto);
  const start = async (selectedStore = store) => {
    const connector = new BrowserConnector({ store: selectedStore, port: 0 });
    connectors.push(connector); await connector.start();
    const base = connector.status().url.replace(/\/v1$/, '');
    const request = (route, body, token, extraHeaders = {}) => fetch(`${base}${route}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { connector, request };
  };
  t.after(async () => {
    await Promise.allSettled(connectors.map(connector => connector.shutdown()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { store, file, crypto, start };
}

async function requestPairing(client) {
  const nonce = randomBytes(32).toString('hex');
  const response = await client.request('/connector/pair', { extensionId, nonce });
  assert.equal(response.status, 202);
  return { nonce, ...(await response.json()) };
}

async function approve(client) {
  const pairing = await requestPairing(client);
  client.connector.approvePairing(pairing.id);
  const response = await client.request('/connector/pair/status', { id: pairing.id, nonce: pairing.nonce });
  assert.equal(response.status, 200);
  return (await response.json()).token;
}

test('approved browser trust is encrypted, survives app restart, and requires a fresh authenticated heartbeat for site readiness', async t => {
  const f = fixture(t), first = await f.start();
  const token = await approve(first);
  const disk = fs.readFileSync(f.file, 'utf8');
  assert.equal(disk.includes(token), false);
  assert.equal(disk.includes(extensionId), false);
  assert.equal(JSON.stringify(f.store.publicState()).includes('encryptedBrowserPairing'), false);
  assert.equal(JSON.stringify(f.store.publicState()).includes(token), false);
  await first.connector.stop();
  const second = await f.start(new Store(f.file, f.crypto));
  assert.equal(second.connector.status().paired, true);
  assert.equal(second.connector.status().extension, undefined, 'A saved version is not presented as an active worker after restart');
  assert.equal(second.connector.status().sites.some(site => site.connected), false);
  const heartbeat = await second.request('/connector/heartbeat', { sites: [{ id: 'claude', connected: true, busy: false }] }, token);
  assert.equal(heartbeat.status, 200);
  assert.deepEqual(second.connector.status().extension, { version: '1.0.5', protocol: CONNECTOR_PROTOCOL, compatible: true });
  assert.equal(second.connector.status().sites.find(site => site.id === 'claude').connected, true);
  assert.equal((await second.request('/connector/jobs', undefined, token, { 'x-connector-extension-id': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })).status, 403);
  assert.equal((await second.request('/connector/jobs', undefined, randomBytes(32).toString('hex'))).status, 401);
});

test('revoking an approved browser connection deletes persisted trust and prevents recovery of its old token', async t => {
  const f = fixture(t), first = await f.start();
  const token = await approve(first);
  first.connector.revoke();
  assert.equal(f.store.browserPairing(), null);
  assert.equal(fs.readFileSync(f.file, 'utf8').includes('encryptedBrowserPairing'), false);
  await first.connector.stop();
  const second = await f.start(new Store(f.file, f.crypto));
  assert.equal(second.connector.status().paired, false);
  assert.equal((await second.request('/connector/jobs', undefined, token)).status, 403);
});

test('pending requests are never persisted and failed encryption cannot approve an extension', async t => {
  const f = fixture(t), first = await f.start();
  const pending = await requestPairing(first);
  f.store.save();
  assert.equal(f.store.browserPairing(), null);
  f.store.encrypt = () => { throw new Error('OS encryption unavailable'); };
  assert.throws(() => first.connector.approvePairing(pending.id), /OS encryption unavailable/);
  assert.equal(first.connector.status().paired, false);
  assert.equal(first.connector.pending.get(pending.id).approved, false);
  assert.equal(f.store.browserPairing(), null);
  await first.connector.stop();
  const second = await f.start(new Store(f.file, f.crypto));
  assert.equal(second.connector.status().paired, false);
  assert.equal(second.connector.status().pendingPairings.length, 0);
});

test('a failed pairing save cannot silently grant remembered trust', async t => {
  const f = fixture(t), client = await f.start();
  const pending = await requestPairing(client);
  t.mock.method(f.store, 'save', () => { throw new Error('Settings directory is read-only'); });
  assert.throws(() => client.connector.approvePairing(pending.id), /read-only/);
  assert.equal(client.connector.status().paired, false);
  assert.equal(client.connector.pending.get(pending.id).approved, false);
  assert.equal(f.store.browserPairing(), null);
});
