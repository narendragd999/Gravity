import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store.mjs';
import { startConfiguredServices, userDataDirectory, importEnvironmentProviders } from '../electron/startup.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gravity-startup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const crypto = { encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() };
  const file = path.join(directory, 'state.json');
  const store = new Store(file, crypto), calls = [];
  const service = name => ({ info: {}, start: async args => { calls.push({ name, args }); return { running: true }; } });
  return { directory, file, crypto, store, calls, gateway: service('gateway'), browserConnector: service('browser'), bridge: service('gemini'), bridges: service('profiles') };
}

test('fresh profiles start the local API and browser connector with no bridge installation required', async t => {
  const f = fixture(t);
  assert.equal(f.store.data.settings.uiScale, 110);
  assert.equal(f.store.data.settings.gatewayAutoStart, true);
  assert.equal(f.store.data.settings.browserAutoStart, true);
  assert.equal(f.store.data.settings.bridgesAutoStart, true);
  assert.equal(f.store.data.settings.bridgeAutoStart, true);
  const results = await startConfiguredServices(f);
  assert.deepEqual(f.calls.map(call => call.name).sort(), ['browser', 'gateway']);
  assert.equal(results.every(result => result.status === 'fulfilled'), true);
  assert.equal(f.calls.find(call => call.name === 'gateway').args.token, f.store.data.settings.gatewayToken);
});

test('saved startup opt-outs and text size survive a restart, and new preferences migrate into old profiles', async t => {
  const f = fixture(t);
  f.store.updateSettings({ gatewayAutoStart: false, browserAutoStart: false, bridgeAutoStart: false, bridgesAutoStart: false, uiScale: 125 });
  const reloaded = new Store(f.file, f.crypto);
  await startConfiguredServices({ ...f, store: reloaded });
  assert.equal(f.calls.length, 0);
  assert.equal(reloaded.data.settings.uiScale, 125);
  const saved = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  delete saved.settings.browserAutoStart; delete saved.settings.bridgesAutoStart; delete saved.settings.bridgeAutoStart; delete saved.settings.uiScale;
  fs.writeFileSync(f.file, JSON.stringify(saved));
  const migrated = new Store(f.file, f.crypto);
  assert.equal(migrated.data.settings.gatewayAutoStart, false);
  assert.equal(migrated.data.settings.browserAutoStart, true);
  assert.equal(migrated.data.settings.bridgesAutoStart, true);
  assert.equal(migrated.data.settings.bridgeAutoStart, true);
  assert.equal(migrated.data.settings.uiScale, 110);
});

test('startup preferences and text size reject malformed values without changing disk', t => {
  const f = fixture(t); f.store.save();
  const before = fs.readFileSync(f.file, 'utf8');
  for (const key of ['gatewayAutoStart', 'browserAutoStart', 'bridgesAutoStart', 'bridgeAutoStart']) {
    for (const value of [0, 1, 'false', null]) assert.throws(() => f.store.updateSettings({ [key]: value }), /true or false/);
  }
  for (const uiScale of [0, 105, 200, '110', null]) assert.throws(() => f.store.updateSettings({ uiScale }), /Text size/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});

test('configured bridges start independently, and a slow or failed adapter cannot hold up other services', async t => {
  const f = fixture(t);
  f.store.data.bridgeProfiles = [{ id: 'slow' }, { id: 'failed' }];
  f.store.updateSettings({ bridgeExecutable: path.join(f.directory, 'adapter.exe'), bridgeConfig: path.join(f.directory, 'config.json') });
  let release, slowStarted = false, failedStarted = false;
  f.bridges.start = id => {
    if (id === 'failed') { failedStarted = true; throw new Error('Missing optional adapter'); }
    slowStarted = true;
    return new Promise(resolve => { release = resolve; });
  };
  const startup = startConfiguredServices(f);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(slowStarted && failedStarted, true);
  assert.deepEqual(f.calls.map(call => call.name).sort(), ['browser', 'gateway', 'gemini']);
  release({ running: true });
  const results = await startup;
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /Missing optional adapter/);
});

test('saved bridge profiles take precedence over the built-in Gemini launcher for the same provider or port', async t => {
  const f = fixture(t);
  f.store.updateSettings({ bridgeExecutable: path.join(f.directory, 'adapter.exe'), bridgeConfig: path.join(f.directory, 'config.json') });
  for (const profile of [
    { id: 'gemini-profile', providerId: 'gemini-local', launchMode: 'external' },
    { id: 'same-port', providerId: 'custom', launchMode: 'managed' },
  ]) {
    f.calls.length = 0;
    f.store.data.providers.push({ id: 'custom', baseUrl: 'http://127.0.0.1:8081/v1' });
    f.store.data.bridgeProfiles = [profile];
    await startConfiguredServices(f);
    assert.equal(f.calls.some(call => call.name === 'gemini'), false);
    assert.equal(f.calls.some(call => call.name === 'profiles' && call.args === profile.id), true);
  }
});

test('a local API startup failure is visible and does not stop browser startup', async t => {
  const f = fixture(t);
  f.gateway.start = async () => { throw new Error('Port is in use'); };
  const results = await startConfiguredServices(f);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(f.gateway.info.error, 'Port is in use');
  assert.equal(f.calls.some(call => call.name === 'browser'), true);
});

test('new Gravity profiles use the new name while existing installations retain data and explicit overrides', () => {
  const appData = path.resolve('app-data');
  assert.equal(userDataDirectory(appData, {}, () => false), path.join(appData, 'Gravity'));
  assert.equal(userDataDirectory(appData, {}, candidate => candidate === path.join(appData, 'Antigravity Studio', 'state.json')), path.join(appData, 'Antigravity Studio'));
  assert.equal(userDataDirectory(appData, { GRAVITY_DATA_DIR: 'new-profile', ANTIGRAVITY_DATA_DIR: 'old-profile' }), path.resolve('new-profile'));
  assert.equal(userDataDirectory(appData, { ANTIGRAVITY_DATA_DIR: 'old-profile' }), path.resolve('old-profile'));
});

test('explicit environment API keys fill known presets without overwriting saved credentials or selections', t => {
  const f = fixture(t);
  importEnvironmentProviders(f.store, { GEMINI_API_KEY: 'first-key' });
  assert.equal(f.store.provider('google-gemini').apiKey, 'first-key');
  f.store.saveProvider({ ...f.store.provider('google-gemini'), defaultModel: 'my-selected-model' });
  importEnvironmentProviders(f.store, { GEMINI_API_KEY: 'replacement-key', OPENAI_API_KEY: 'openai-key' });
  assert.equal(f.store.provider('google-gemini').apiKey, 'first-key');
  assert.equal(f.store.provider('google-gemini').defaultModel, 'my-selected-model');
  assert.equal(f.store.provider('openai').apiKey, 'openai-key');
  assert.doesNotMatch(fs.readFileSync(f.file, 'utf8'), /first-key|openai-key|replacement-key/);
});
