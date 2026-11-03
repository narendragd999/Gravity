import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { Store } from '../electron/store.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-store-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  const crypto = {
    encrypt(text) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64'); },
    decrypt(text) { const data = Buffer.from(text, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'); }
  };
  const file = path.join(directory, 'state.json');
  return { file, crypto, store: new Store(file, crypto) };
}
const profile = { name: 'Custom', type: 'openai', baseUrl: 'https://models.example/custom', models: ['model-a'], defaultModel: 'model-a' };

test('store encrypts provider keys and headers at rest and masks public renderer state', t => {
  const { file, store, crypto } = fixture(t);
  const saved = store.saveProvider({ ...profile, apiKey: 'private-provider-secret', headers: { 'x-tenant-secret': 'private-header-value' } });
  assert.equal(saved.hasApiKey, true); assert.deepEqual(saved.headers, { 'x-tenant-secret': '********' });
  const publicText = JSON.stringify(store.publicState());
  for (const secret of ['private-provider-secret', 'private-header-value', 'encryptedApiKey', 'encryptedHeaders']) assert.equal(publicText.includes(secret), false);
  const disk = fs.readFileSync(file, 'utf8'); assert.doesNotMatch(disk, /private-provider-secret|private-header-value/);
  const reloaded = new Store(file, crypto); assert.equal(reloaded.provider(saved.id).apiKey, 'private-provider-secret'); assert.equal(reloaded.provider(saved.id).headers['x-tenant-secret'], 'private-header-value');
});

test('store preserves omitted/masked secrets and explicitly clears removed secrets', t => {
  const { store } = fixture(t);
  const saved = store.saveProvider({ ...profile, apiKey: 'secret-key', headers: { authorization: 'Bearer secret-header' } });
  store.saveProvider({ ...profile, id: saved.id, name: 'Renamed' });
  assert.equal(store.provider(saved.id).apiKey, 'secret-key');
  store.saveProvider({ ...profile, id: saved.id, headers: { authorization: '********' } });
  assert.equal(store.provider(saved.id).headers.authorization, 'Bearer secret-header');
  store.saveProvider({ ...profile, id: saved.id, apiKey: '', headers: {} });
  assert.equal(store.provider(saved.id).apiKey, ''); assert.deepEqual(store.provider(saved.id).headers, {});
});

test('store validates provider URL and header boundaries before saving', t => {
  const { store } = fixture(t); const count = store.data.providers.length;
  for (const baseUrl of ['file:///secrets', 'https://user:pass@models.example', 'https://models.example/#secret', 'https://models.example/?token=secret']) assert.throws(() => store.saveProvider({ ...profile, baseUrl }));
  for (const headers of [{ Host: 'other.example' }, { Cookie: 'secret' }, { 'x-header': 'one\r\ntwo' }, { 'bad header': 'value' }]) assert.throws(() => store.saveProvider({ ...profile, headers }));
  assert.equal(store.data.providers.length, count);
});

test('store retains state and invalidates pending runs and approvals after restart', t => {
  const { store, file, crypto } = fixture(t);
  const c = store.createConversation({ title: 'Persisted conversation', mode: 'plan' });
  store.data.conversations[0].status = 'running'; store.data.conversations[0].messages.push({ id: 'approval', role: 'tool', content: 'Review', approval: { id: 'a', status: 'pending' } }); store.save();
  const reloaded = new Store(file, crypto); assert.equal(reloaded.conversation(c.id).title, c.title); assert.equal(reloaded.conversation(c.id).mode, 'plan');
  assert.equal(reloaded.conversation(c.id).status, 'idle'); assert.equal(reloaded.conversation(c.id).messages[0].approval.status, 'rejected');
});

test('store rejects invalid settings atomically and preserves file on corrupt input', t => {
  const { store, file, crypto } = fixture(t); store.save(); const before = fs.readFileSync(file, 'utf8');
  for (const settings of [{ gatewayPort: 80 }, { gatewayPort: 8081 }, { bridgePort: 65536 }, { maxSteps: 0 }, { maxSteps: 65 }, { theme: 'rainbow' }, { gatewayToken: 'short' }]) assert.throws(() => store.updateSettings(settings));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  store.updateSettings({ theme: 'dark', maxSteps: 8 }); assert.equal(new Store(file, crypto).data.settings.theme, 'dark');
  fs.writeFileSync(file, '{broken'); assert.throws(() => new Store(file, crypto)); assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('changing the provider or model clears a failed status while preserving conversation history', t => {
  const { store, file, crypto } = fixture(t);
  const first = store.saveProvider(profile);
  const second = store.saveProvider({ ...profile, name: 'Second provider', models: ['model-b'], defaultModel: 'model-b' });
  for (const selection of [{ providerId: second.id }, { model: 'model-b' }]) {
    const conversation = store.createConversation({ providerId: first.id, model: 'model-a' });
    const current = store.conversation(conversation.id);
    current.status = 'error';
    current.messages = [
      { id: 'user-message', role: 'user', content: 'Keep my question' },
      { id: 'previous-error', role: 'assistant', content: 'Request failed: old provider unavailable' },
    ];
    current.apiHistory = [{ role: 'user', content: 'Keep my question' }];
    store.save();
    const messages = structuredClone(current.messages), apiHistory = structuredClone(current.apiHistory);
    const updated = store.updateConversation({ id: current.id, ...selection });
    assert.equal(updated.status, 'idle');
    for (const [key, value] of Object.entries(selection)) assert.equal(updated[key], value);
    assert.deepEqual(updated.messages, messages);
    assert.deepEqual(updated.apiHistory, apiHistory);
    const persisted = new Store(file, crypto).conversation(current.id);
    assert.equal(persisted.status, 'idle');
    assert.deepEqual(persisted.messages, messages);
    assert.deepEqual(persisted.apiHistory, apiHistory);
  }
});

test('unchanged provider selections and unrelated edits preserve a failed status', t => {
  const { store } = fixture(t);
  const provider = store.saveProvider(profile);
  const conversation = store.createConversation({ providerId: provider.id, model: 'model-a' });
  store.conversation(conversation.id).status = 'error';
  for (const change of [
    {}, { providerId: provider.id }, { model: 'model-a' }, { providerId: provider.id, model: 'model-a' },
    { title: 'Renamed conversation' }, { archived: true }, { mode: 'plan' },
  ]) {
    const updated = store.updateConversation({ id: conversation.id, ...change });
    assert.equal(updated.status, 'error');
  }
});

test('provider selection changes cannot reset an active conversation', t => {
  const { store, file } = fixture(t);
  const provider = store.saveProvider(profile);
  const conversation = store.createConversation({ providerId: provider.id, model: 'model-a' });
  const current = store.conversation(conversation.id);
  current.status = 'running';
  current.messages = [{ role: 'user', content: 'Still generating' }];
  current.apiHistory = [{ role: 'user', content: 'Earlier question' }];
  store.save();
  const before = structuredClone(current), disk = fs.readFileSync(file, 'utf8');
  for (const change of [{ providerId: 'ollama' }, { model: 'model-b' }, { providerId: provider.id, model: 'model-a' }]) {
    assert.throws(() => store.updateConversation({ id: current.id, ...change }), /Stop the conversation/);
    assert.deepEqual(current, before);
    assert.equal(fs.readFileSync(file, 'utf8'), disk);
  }
  assert.equal(store.updateConversation({ id: current.id, title: 'Updated title' }).status, 'running');
});

test('invalid provider selections leave the failed conversation and stored history unchanged', t => {
  const { store, file } = fixture(t);
  const conversation = store.createConversation();
  const current = store.conversation(conversation.id);
  current.status = 'error';
  current.messages = [{ role: 'assistant', content: 'Request failed' }];
  current.apiHistory = [{ role: 'user', content: 'Saved prompt' }];
  store.save();
  const before = structuredClone(current), disk = fs.readFileSync(file, 'utf8');
  for (const change of [{ providerId: 'missing-provider' }, { model: 42 }, { model: 'model-b', mode: 'invalid-mode' }]) {
    assert.throws(() => store.updateConversation({ id: current.id, ...change }));
    assert.deepEqual(current, before);
    assert.equal(fs.readFileSync(file, 'utf8'), disk);
  }
});
