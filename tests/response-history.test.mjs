import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { Store } from '../electron/store.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gravity-response-history-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = path.join(directory, 'state.json');
  const key = randomBytes(32);
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
  const store = new Store(file, crypto);
  const provider = store.saveProvider({ name: 'Fixture', type: 'openai', baseUrl: 'http://127.0.0.1:4320/v1', models: ['chatgpt-web', 'qwen-web'], defaultModel: 'chatgpt-web', apiKey: 'fixture-key', headers: { 'x-test': 'fixture-value' } });
  return { store, provider, file, crypto };
}

test('response checks for separate models survive restart and retain success/failure timestamps', t => {
  const { store, provider, file, crypto } = fixture(t);
  store.recordProviderTest(provider.id, { ok: true, message: 'Received text.' }, { model: 'chatgpt-web', checkedAt: '2026-11-06T01:00:00Z', durationMs: 1300 });
  store.recordProviderTest(provider.id, { ok: false, code: 'empty_response', message: 'No answer.' }, { model: 'qwen-web', checkedAt: '2026-11-06T01:01:00Z', durationMs: 800 });
  store.recordProviderTest(provider.id, { ok: false }, { model: 'chatgpt-web', checkedAt: '2026-11-06T01:02:00Z' });
  const reloaded = new Store(file, crypto).publicState().providers.find(item => item.id === provider.id);
  assert.equal(reloaded.responseChecks.length, 2);
  const chatgpt = reloaded.responseChecks.find(check => check.model === 'chatgpt-web');
  assert.equal(chatgpt.ok, false); assert.equal(chatgpt.lastSuccessAt, '2026-11-06T01:00:00Z');
  assert.equal(chatgpt.lastFailureAt, '2026-11-06T01:02:00Z');
  assert.equal(reloaded.responseChecks.find(check => check.model === 'qwen-web').code, 'empty_response');
});

test('rename/model edits preserve route checks while changed credentials invalidate them', t => {
  const { store, provider } = fixture(t);
  store.recordProviderTest(provider.id, { ok: true }, { model: 'chatgpt-web' });
  const rename = store.saveProvider({ ...provider, name: 'Renamed', models: [...provider.models, 'zai-web'], headers: { 'x-test': '********' } });
  assert.equal(rename.responseChecks.length, 1);
  const changed = store.saveProvider({ ...rename, apiKey: 'different-fixture-key' });
  assert.equal(changed.responseChecks, undefined); assert.equal(changed.lastTest, undefined);
});

test('a test finishing after a connection change cannot certify the replacement connection', t => {
  const { store, provider } = fixture(t), stamp = store.providerConnectionStamp(provider.id);
  store.saveProvider({ ...provider, baseUrl: 'http://127.0.0.1:9998/v1' });
  assert.equal(store.recordProviderTest(provider.id, { ok: true }, { model: 'chatgpt-web', connectionStamp: stamp }), false);
  assert.equal(store.publicState().providers.find(item => item.id === provider.id).lastTest, undefined);
});

test('response history rejects invalid records and rolls back failed persistence', t => {
  const { store, provider } = fixture(t);
  assert.throws(() => store.recordProviderTest(provider.id, { ok: 'yes' }, { model: 'chatgpt-web' }), /Invalid response check/);
  const save = store.save; store.save = () => { throw new Error('Fixture disk unavailable'); };
  assert.throws(() => store.recordProviderTest(provider.id, { ok: true }, { model: 'chatgpt-web' }), /disk unavailable/);
  store.save = save;
  assert.equal(store.data.providers.find(item => item.id === provider.id).responseChecks, undefined);
});

const pairing = { extensionId: 'abcdefghijklmnopabcdefghijklmnop', token: 'a'.repeat(64), extension: { version: '1.0.5', protocol: 1 } };

function browserFixture(t) {
  const f = fixture(t);
  const browserProviders = ['Browser one', 'Browser two'].map(name => f.store.saveProvider({ name, type: 'openai', baseUrl: 'http://127.0.0.1:4319/v1', managedBy: 'browser-connector', models: ['chatgpt-web', 'qwen-web'], defaultModel: 'chatgpt-web' }));
  const web2api = f.store.saveProvider({ name: 'Web2API', type: 'openai', baseUrl: 'http://127.0.0.1:4320/v1', managedBy: 'web2api', models: ['qwen-web'], defaultModel: 'qwen-web' });
  f.store.saveBrowserPairing(pairing);
  for (const provider of [...browserProviders, f.provider, web2api]) {
    f.store.recordProviderTest(provider.id, { ok: true, message: 'Received an answer.' }, { model: provider.defaultModel });
  }
  f.store.recordProviderTest(browserProviders[0].id, { ok: false, code: 'empty_response' }, { model: 'qwen-web' });
  return { ...f, browserProviders, nonbrowserProviders: [f.provider, web2api] };
}

function assertBrowserChecksCleared(store, browserProviders) {
  for (const { id } of browserProviders) {
    const provider = store.publicState().providers.find(item => item.id === id);
    assert.equal(provider.lastTest, undefined);
    assert.equal(provider.responseChecks, undefined);
  }
}

test('revoking browser trust clears managed provider checks on disk and rejects old in-flight results', t => {
  const { store, file, crypto, browserProviders, nonbrowserProviders } = browserFixture(t);
  const browser = browserProviders[0], oldStamp = store.providerConnectionStamp(browser.id);
  const otherChecks = nonbrowserProviders.map(({ id }) => ({ id, stamp: store.providerConnectionStamp(id), provider: store.provider(id) }));
  store.clearBrowserPairing();
  assert.equal(store.browserPairing(), null);
  assertBrowserChecksCleared(store, browserProviders);
  const reloaded = new Store(file, crypto);
  assert.equal(reloaded.browserPairing(), null);
  assertBrowserChecksCleared(reloaded, browserProviders);
  assert.equal(store.recordProviderTest(browser.id, { ok: true }, { model: 'chatgpt-web', connectionStamp: oldStamp }), false);
  for (const { id, stamp, provider } of otherChecks) {
    assert.deepEqual(store.provider(id), provider);
    assert.deepEqual(reloaded.provider(id), provider);
    assert.equal(store.providerConnectionStamp(id), stamp);
  }
  // Re-approving the same identity after revocation is a new trust grant.
  store.saveBrowserPairing(pairing);
  assert.notEqual(store.providerConnectionStamp(browser.id), oldStamp);
  assert.equal(store.recordProviderTest(browser.id, { ok: true }, { model: 'chatgpt-web', connectionStamp: oldStamp }), false);
});

test('a deliberately replaced browser token or extension invalidates all prior managed response checks', async t => {
  for (const replacement of [{ ...pairing, token: 'b'.repeat(64) }, { ...pairing, extensionId: 'b'.repeat(32) }]) {
    await t.test(replacement.token !== pairing.token ? 'new token' : 'new extension', t => {
      const { store, file, crypto, browserProviders, nonbrowserProviders } = browserFixture(t);
      const browser = browserProviders[0], oldStamp = store.providerConnectionStamp(browser.id);
      const otherChecks = nonbrowserProviders.map(({ id }) => store.provider(id));
      store.saveBrowserPairing(replacement);
      assert.deepEqual(store.browserPairing(), replacement);
      assertBrowserChecksCleared(store, browserProviders);
      assertBrowserChecksCleared(new Store(file, crypto), browserProviders);
      assert.equal(store.recordProviderTest(browser.id, { ok: true }, { model: 'chatgpt-web', connectionStamp: oldStamp }), false);
      for (const provider of otherChecks) assert.deepEqual(store.provider(provider.id), provider);
      const currentStamp = store.providerConnectionStamp(browser.id);
      assert.equal(store.recordProviderTest(browser.id, { ok: true }, { model: 'chatgpt-web', connectionStamp: currentStamp }).ok, true);
      assert.equal(new Store(file, crypto).provider(browser.id).lastTest.ok, true);
    });
  }
});

test('unchanged browser trust keeps response history and connection stamps across saves and restart', t => {
  const { store, file, crypto, browserProviders } = browserFixture(t);
  const browser = browserProviders[0], before = store.provider(browser.id);
  const ciphertext = store.data.encryptedBrowserPairing, stamp = store.providerConnectionStamp(browser.id);
  store.saveBrowserPairing({ ...pairing, extension: { version: '1.0.6', protocol: 1 } });
  assert.equal(store.data.encryptedBrowserPairing, ciphertext, 'An unchanged trust grant must not receive fresh encryption randomness');
  assert.deepEqual(store.provider(browser.id), before);
  assert.equal(store.providerConnectionStamp(browser.id), stamp);
  const reloaded = new Store(file, crypto);
  assert.deepEqual(reloaded.provider(browser.id), before);
  assert.equal(reloaded.providerConnectionStamp(browser.id), stamp);
  assert.equal(reloaded.recordProviderTest(browser.id, { ok: true }, { model: 'chatgpt-web', connectionStamp: stamp }).ok, true);
});

test('failed pairing changes roll back trust and every response check together', async t => {
  for (const operation of ['revoke', 'new token', 'new extension']) {
    await t.test(operation, t => {
      const { store, file, crypto, browserProviders } = browserFixture(t);
      const before = structuredClone(store.data), disk = fs.readFileSync(file, 'utf8');
      const browser = browserProviders[0], stamp = store.providerConnectionStamp(browser.id);
      const save = store.save;
      store.save = () => { throw new Error('Fixture disk unavailable'); };
      assert.throws(() => operation === 'revoke' ? store.clearBrowserPairing() : store.saveBrowserPairing({ ...pairing, ...(operation === 'new token' ? { token: 'b'.repeat(64) } : { extensionId: 'b'.repeat(32) }) }), /disk unavailable/);
      store.save = save;
      assert.deepEqual(store.data, before);
      assert.equal(fs.readFileSync(file, 'utf8'), disk);
      assert.deepEqual(new Store(file, crypto).browserPairing(), pairing);
      assert.equal(store.providerConnectionStamp(browser.id), stamp);
      assert.equal(store.recordProviderTest(browser.id, { ok: true }, { model: 'chatgpt-web', connectionStamp: stamp }).ok, true);
    });
  }
});
