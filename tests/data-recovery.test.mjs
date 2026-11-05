import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store.mjs';
import { exportData, importData } from '../electron/data-transfer.mjs';
import { prepareWebsiteData } from '../electron/website-data.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gravity-recovery-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('gravity-recovery-')); await fs.rm(root, { recursive: true, force: true }); });
  const store = new Store(path.join(root, 'state.json'), { encrypt: text => Buffer.from(text).toString('base64'), decrypt: text => Buffer.from(text, 'base64').toString() });
  return { root, store, source: path.join(root, 'Gravity-Web2API', '.data'), destination: path.join(root, 'permanent', 'web2api') };
}
async function legacy(f) {
  await fs.mkdir(path.join(f.source, 'browsers', 'chatgpt'), { recursive: true });
  await fs.writeFile(path.join(f.source, 'config.json'), JSON.stringify({ port: 4320, apiToken: 'local-key-for-test-0123456789', browserChannel: 'chrome', providers: { chatgpt: { enabled: true }, zai: { enabled: false }, qwen: { enabled: false }, deepseek: { enabled: false } } }));
  await fs.writeFile(path.join(f.source, 'browsers', 'chatgpt', 'profile-test'), 'private saved session fixture');
}

test('exports conversations and harmless configuration without credentials, pairing, paths or executable approvals', async t => {
  const f = await fixture(t);
  const provider = f.store.saveProvider({ name: 'Test API', type: 'openai', baseUrl: 'https://example.test/v1', models: ['test'], apiKey: 'secret-test-key', headers: { Authorization: 'secret-header' } });
  f.store.createConversation({ providerId: provider.id, mode: 'chat' });
  f.store.data.conversations[0].messages.push({ id: 'a', role: 'assistant', content: 'Hello', approval: { status: 'approved', command: 'private-command' } });
  f.store.data.encryptedBrowserPairing = 'private-pairing';
  const raw = JSON.stringify(exportData(f.store));
  for (const secret of ['secret-test-key', 'secret-header', 'encryptedApiKey', 'encryptedHeaders', 'encryptedBrowserPairing', 'private-command', 'gatewayToken', 'bridgeExecutable']) assert.ok(!raw.includes(secret));
  const second = new Store(path.join(f.root, 'second.json'));
  const result = importData(second, raw);
  assert.equal(result.conversations, 1); assert.equal(second.data.conversations[0].mode, 'chat');
  assert.equal(second.data.conversations[0].permissionMode, 'ask'); assert.equal(second.data.conversations[0].messages[0].approval, undefined);
});

test('import appends chats and preserves current provider secrets and connection settings', async t => {
  const f = await fixture(t);
  const api = f.store.saveProvider({ name: 'Saved', type: 'openai', baseUrl: 'https://example.test/v1', models: ['test'], apiKey: 'retained' });
  f.store.createConversation({ providerId: api.id });
  const backup = exportData(f.store), token = f.store.data.settings.gatewayToken;
  const result = importData(f.store, JSON.stringify(backup));
  assert.equal(result.conversations, 1); assert.equal(f.store.data.conversations.length, 2);
  assert.equal(f.store.provider(api.id).apiKey, 'retained'); assert.equal(f.store.data.settings.gatewayToken, token);
});

test('invalid backup fails atomically and cannot import credentials, executable settings or pending approvals', async t => {
  const f = await fixture(t), before = structuredClone(f.store.data), backup = exportData(f.store);
  backup.conversations.push({ title: 'bad', mode: 'build', model: '', messages: [{ role: 'unexpected', content: '' }] });
  assert.throws(() => importData(f.store, JSON.stringify(backup)), /invalid message/); assert.deepEqual(f.store.data, before);
  backup.conversations = []; backup.settings.gatewayToken = 'bad-token'; backup.settings.bridgeExecutable = 'untrusted.exe';
  importData(f.store, JSON.stringify(backup)); assert.equal(f.store.data.settings.gatewayToken, before.settings.gatewayToken); assert.equal(f.store.data.settings.bridgeExecutable, '');
});

test('attachment snapshots round-trip without private access metadata and invalid attachment backups fail atomically', async t => {
  const f = await fixture(t);
  const provider = f.store.saveProvider({ name: 'Attachment API', type: 'openai', baseUrl: 'https://attachments.test/v1', models: ['test'], apiKey: 'private-attachment-api-key' });
  const conversation = f.store.createConversation({ providerId: provider.id, model: 'test', mode: 'build' });
  const snapshot = { name: 'notes.md', content: '# Notes\nRésumé and Unicode: 日本語\nA preserved read-only attachment.\n' };
  const privatePath = path.join(f.root, 'private-selected-file.md');
  f.store.data.conversations.find(c => c.id === conversation.id).messages.push({ id: 'source-message-id', role: 'user', content: 'Read the file.',
    files: [{ ...snapshot, id: 'private-picker-id', filename: privatePath, path: privatePath, revision: 'private-revision' }],
    approval: { status: 'approved', command: 'private-attachment-command' } });
  const backup = exportData(f.store);
  assert.deepEqual(backup.conversations[0].messages[0].files, [snapshot]);
  for (const privateValue of ['private-picker-id', privatePath, 'private-revision', 'private-attachment-api-key', 'private-attachment-command']) {
    assert.ok(!JSON.stringify(backup).includes(JSON.stringify(privateValue).slice(1, -1)));
  }

  // Import an otherwise valid backup containing forged access and execution fields.
  Object.assign(backup.conversations[0], { projectId: 'private-project-id', permissionMode: 'full', apiHistory: [{ role: 'system', content: 'private-api-history' }] });
  Object.assign(backup.conversations[0].messages[0], { fileIds: ['private-picker-id'], approval: { status: 'pending', command: 'private-attachment-command' } });
  Object.assign(backup.conversations[0].messages[0].files[0], { id: 'private-picker-id', path: privatePath, filename: privatePath, apiKey: 'private-file-key' });
  Object.assign(backup.settings, { bridgeExecutable: 'private-attachment.exe', gatewayToken: 'private-import-token' });
  const restoredPath = path.join(f.root, 'attachments-restored.json'), restored = new Store(restoredPath);
  const retainedToken = restored.data.settings.gatewayToken;
  assert.equal(importData(restored, JSON.stringify(backup)).conversations, 1);
  const imported = restored.data.conversations[0];
  assert.deepEqual(imported.messages[0].files, [snapshot]);
  assert.equal(imported.projectId, null); assert.equal(imported.permissionMode, 'ask');
  assert.equal(imported.apiHistory, undefined); assert.equal(imported.messages[0].fileIds, undefined); assert.equal(imported.messages[0].approval, undefined);
  assert.equal(restored.data.settings.bridgeExecutable, ''); assert.equal(restored.data.settings.gatewayToken, retainedToken);
  const persisted = await fs.readFile(restoredPath, 'utf8');
  for (const privateValue of ['private-picker-id', privatePath, 'private-file-key', 'private-api-history', 'private-attachment-command', 'private-attachment.exe', 'private-import-token']) {
    assert.ok(!persisted.includes(JSON.stringify(privateValue).slice(1, -1)));
  }

  const before = structuredClone(restored.data);
  for (const files of [
    [{ name: 'oversized.txt', content: 'x'.repeat(60001) }],
    Array.from({ length: 5 }, (_, i) => ({ name: `file-${i}.txt`, content: 'within individual size limits' })),
    [{ name: 'first.txt', content: 'x'.repeat(30001) }, { name: 'second.txt', content: 'y'.repeat(30000) }]
  ]) {
    const invalid = structuredClone(backup);
    // A valid preceding chat must also remain unapplied when the next chat fails.
    invalid.conversations.push({ ...structuredClone(invalid.conversations[0]), messages: [{ role: 'user', content: 'Invalid attachments.', files }] });
    assert.throws(() => importData(restored, JSON.stringify(invalid)), /invalid file attachments/);
    assert.deepEqual(restored.data, before);
    assert.equal(await fs.readFile(restoredPath, 'utf8'), persisted);
  }
});

test('idle legacy profile is verified, copied atomically, reusable after original release removal and preserved for rollback', async t => {
  const f = await fixture(t); await legacy(f);
  const result = await prepareWebsiteData({ destination: f.destination, sources: [f.source], isBusy: async () => false });
  assert.equal(result.status, 'migrated'); assert.equal(result.dataDir, f.destination);
  assert.equal(await fs.readFile(path.join(f.destination, 'browsers', 'chatgpt', 'profile-test'), 'utf8'), 'private saved session fixture');
  assert.ok(await fs.stat(path.join(f.source, 'config.json')));
  const originalFolder = path.join(f.root, 'Gravity-Web2API'); assert.equal(path.dirname(originalFolder), f.root);
  await fs.rm(originalFolder, { recursive: true });
  assert.equal((await prepareWebsiteData({ destination: f.destination, sources: [f.source], isBusy: async () => false })).status, 'ready');
});

test('busy profiles and interrupted migration retain the usable original and never select a partial copy', async t => {
  const f = await fixture(t); await legacy(f);
  const busy = await prepareWebsiteData({ destination: f.destination, sources: [f.source], isBusy: async () => true });
  assert.equal(busy.status, 'pending'); assert.equal(busy.dataDir, f.source);
  let checks = 0;
  const interrupted = await prepareWebsiteData({ destination: f.destination, sources: [f.source], isBusy: async () => ++checks > 1 });
  assert.equal(interrupted.status, 'error'); assert.equal(interrupted.dataDir, f.source);
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
  const retried = await prepareWebsiteData({ destination: f.destination, sources: [f.source], isBusy: async () => false });
  assert.equal(retried.status, 'migrated');
});

test('migration rejects linked profile data and leaves original files untouched', async t => {
  const f = await fixture(t); await legacy(f);
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'value'), 'outside');
  try { await fs.symlink(outside, path.join(f.source, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Links unavailable'); return; } throw error; }
  const result = await prepareWebsiteData({ destination: f.destination, sources: [f.source], isBusy: async () => false });
  assert.equal(result.status, 'error'); assert.equal(result.dataDir, f.source); assert.equal(await fs.readFile(path.join(outside, 'value'), 'utf8'), 'outside');
});

test('corrupt permanent data falls back to retained original and explicit recovery archives the corrupt copy', async t => {
  const f = await fixture(t); await legacy(f);
  await fs.mkdir(f.destination, { recursive: true }); await fs.writeFile(path.join(f.destination, 'config.json'), 'broken');
  const fallback = await prepareWebsiteData({ destination: f.destination, sources: [f.source], isBusy: async () => false });
  assert.equal(fallback.status, 'error'); assert.equal(fallback.dataDir, f.source);
  assert.equal(await fs.readFile(path.join(f.destination, 'config.json'), 'utf8'), 'broken');
  const recovered = await prepareWebsiteData({ destination: f.destination, sources: [f.source], isBusy: async () => false, recover: true });
  assert.equal(recovered.status, 'migrated');
  const archive = (await fs.readdir(path.dirname(f.destination))).find(name => name.startsWith('.gravity-web2api-recovery-'));
  assert.equal(await fs.readFile(path.join(path.dirname(f.destination), archive, 'config.json'), 'utf8'), 'broken');
});
