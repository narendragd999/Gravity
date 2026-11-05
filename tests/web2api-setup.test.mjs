import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Store } from '../electron/store.mjs';
import { Web2ApiSetup } from '../electron/web2api-setup.mjs';
import { LOGIN_EVENT_PREFIX } from '../bridges/multi-web2api/login-events.mjs';

const LOCAL_KEY = 'fixture-local-key-12345678901234567890';
const labels = ['chatgpt', 'zai', 'deepseek', 'qwen'];
const until = async check => {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Fixture did not reach expected state.'); await new Promise(resolve => setTimeout(resolve, 5)); }
};

async function fixture(t, { enabled = ['zai'], running = false, delayLogin = false, delayBrowsers = false, dataOutside = false, legacyDataDirs = false } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gravity-web2api-setup-'));
  assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'companion'), cwd = path.join(root, 'bridge'), executable = path.join(root, 'runtime', 'node.exe');
  const dataDir = dataOutside ? path.join(base, 'durable-user-data') : path.join(root, '.data');
  await fs.mkdir(cwd, { recursive: true }); await fs.mkdir(path.dirname(executable)); await fs.mkdir(dataDir);
  await fs.writeFile(executable, 'fixture runtime'); await fs.writeFile(path.join(cwd, 'cli.mjs'), 'fixture helper');
  const configFile = path.join(dataDir, 'config.json');
  const config = { port: 4320, apiToken: LOCAL_KEY, browserChannel: 'chrome', providers: Object.fromEntries(labels.map(id => [id, { enabled: enabled.includes(id) }])) };
  await fs.writeFile(configFile, JSON.stringify(config));
  const store = new Store(path.join(base, 'state.json'), { encrypt: text => Buffer.from(text).toString('base64'), decrypt: text => Buffer.from(text, 'base64').toString() });
  const commands = [], helperChildren = [], changes = [], bridgeCalls = [], entries = new Map();
  let serverRunning = running, loadedSites = [...enabled]; const profileOpenSites = new Set(), serviceCalls = [];
  const bridges = {
    entries, status: () => store.data.bridgeProfiles.map(profile => ({ id: profile.id, running: entries.get(profile.id)?.ready || false, starting: false, state: entries.get(profile.id)?.ready ? 'ready' : 'stopped', logs: [] })),
    async start(id) { bridgeCalls.push(['start', id]); serverRunning = true; loadedSites = labels.filter(site => config.providers[site].enabled); entries.set(id, { ready: true, child: { pid: 100 } }); return this.status().find(item => item.id === id); },
    async check(id) { bridgeCalls.push(['check', id]); entries.set(id, { ready: true }); return this.status().find(item => item.id === id); },
    async stop(id) { bridgeCalls.push(['stop', id]); if (entries.get(id)?.child) serverRunning = false; entries.delete(id); },
  };
  const preset = { provider: { type: 'openai', name: 'Gravity Web2API', baseUrl: 'http://127.0.0.1:4320/v1', apiKey: LOCAL_KEY },
    bridge: { executable, args: [path.join(cwd, 'cli.mjs'), 'start', '--data-dir', dataDir], cwd, healthUrl: 'http://127.0.0.1:4320/health' } };
  const setup = new Web2ApiSetup({ store, bridges, companionRoots: [{ root, dataDir }], previousDataDirs: legacyDataDirs ? [path.join(root, '.data')] : [], changed: () => changes.push(setup.status()),
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname; serviceCalls.push([pathname, options.method]);
      if (pathname === '/status') return new Response(JSON.stringify({ providers: loadedSites.map(id => ({ id, busy: false, browserProfileOpen: profileOpenSites.has(id) })) }));
      const match = /^\/profiles\/(\w+)\/close$/.exec(pathname); if (match) { profileOpenSites.delete(match[1]); return new Response(JSON.stringify({ siteId: match[1], released: true })); }
      throw new Error('Unexpected fixture service path');
    },
    discover: async (provider, options) => {
      assert.equal(provider.apiKey, LOCAL_KEY); assert.ok(options.signal);
      if (!serverRunning) throw Object.assign(new Error('fixture connection refused'), { code: 'connection_refused' });
      return loadedSites.map(id => `${id}-web`);
    },
    spawnProcess: (node, args, options) => {
      assert.equal(node, executable); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
      commands.push(args.slice(1));
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { child.killed = true; child.emit('close', 1); };
      let inputPayload = '';
      const complete = async () => {
        if (child.completed) return; child.completed = true;
        if (args[1] === 'info') { child.stdout.write(JSON.stringify(preset)); child.emit('close', 0); return; }
        if (args[1] === 'browsers') { child.stdout.write(JSON.stringify({ browserChannel: config.browserChannel, runtimeVersion: 'v22.13.0', browsers: [{ channel: 'chrome', installed: true }, { channel: 'msedge', installed: true }] })); child.emit('close', 0); return; }
        if (args[1] === 'browser') { for (const provider of Object.values(config.providers)) if (provider.enabled && !provider.browserChannel) provider.browserChannel = config.browserChannel; config.browserChannel = args[2]; await fs.writeFile(configFile, JSON.stringify(config)); child.stdout.write('{}'); child.emit('close', 0); return; }
        if (args[1] === 'restore-site') { const recovery = JSON.parse(inputPayload); assert.deepEqual(config.providers[args[2]], recovery.expected); config.providers[args[2]] = recovery.previous; await fs.writeFile(configFile, JSON.stringify(config)); child.stdout.write('{"restored":true}'); child.emit('close', 0); return; }
        config.providers[args[2]].enabled = true; await fs.writeFile(configFile, JSON.stringify(config));
        child.stdout.write('Checking your saved sign-in.\n'); child.emit('close', 0);
      };
      child.complete = complete; helperChildren.push(child);
      child.stdin.on('data', chunk => { if (args[1] === 'restore-site') { inputPayload += chunk.toString(); return; } if (chunk.toString().includes('cancel')) child.emit('close', 1); else void complete(); });
      child.stdin.on('finish', () => { if (args[1] === 'restore-site') void complete(); });
      queueMicrotask(() => { if (['info', 'browser'].includes(args[1]) || (args[1] === 'browsers' && !delayBrowsers) || (args[1] === 'login' && !delayLogin)) void complete(); });
      return child;
    } });
  t.after(() => setup.close());
  return { base, root, dataDir, cwd, executable, store, setup, bridges, commands, changes, bridgeCalls, helperChildren, config, preset, profileOpenSites, serviceCalls };
}

test('one-click connection creates encrypted provider and managed startup without sending a prompt', async t => {
  const f = await fixture(t);
  const result = await f.setup.connect('zai');
  assert.equal(result.phase, 'ready'); assert.equal(result.defaultModel, 'zai-web'); assert.equal(result.busy, false);
  assert.equal(f.store.provider(result.providerId).apiKey, LOCAL_KEY);
  assert.equal(f.store.provider(result.providerId).managedBy, 'web2api');
  assert.equal(f.store.data.settings.bridgesAutoStart, true);
  const profile = f.store.bridgeProfile(result.bridgeId);
  assert.equal(profile.launchMode, 'managed'); assert.deepEqual(profile.args, f.preset.bridge.args);
  assert.deepEqual(f.bridgeCalls.map(call => call[0]), ['start']);
  assert.deepEqual(f.commands.map(command => command[0]), ['info']);
  assert.ok(!JSON.stringify(f.changes).includes(LOCAL_KEY));
});

test('existing ZLM connection and live external server are reused without stopping their process', async t => {
  const f = await fixture(t, { running: true });
  const previous = f.store.saveProvider({ name: 'ZLM', type: 'openai', baseUrl: f.preset.provider.baseUrl, apiKey: LOCAL_KEY, models: ['zai-web'], defaultModel: 'zai-web' });
  const providerCount = f.store.data.providers.length;
  const result = await f.setup.connect('zai');
  assert.equal(result.providerId, previous.id); assert.equal(f.store.data.providers.length, providerCount);
  assert.equal(f.store.provider(previous.id).name, 'ZLM'); assert.equal(result.externallyRunning, true);
  assert.equal(f.store.provider(previous.id).managedBy, 'web2api');
  assert.deepEqual(f.bridgeCalls.map(call => call[0]), ['check']);
  await f.setup.close(); assert.deepEqual(f.bridgeCalls.map(call => call[0]), ['check']);
});

test('first sign-in waits for helper success then finishes provider and bridge setup', async t => {
  const f = await fixture(t, { enabled: [], delayLogin: true });
  const operation = f.setup.connect('qwen');
  await until(() => f.commands.some(command => command[0] === 'login'));
  assert.equal(f.setup.status().phase, 'login'); assert.equal(f.setup.status().busy, true);
  assert.equal(f.store.data.bridgeProfiles.length, 0);
  assert.ok(f.commands.find(command => command[0] === 'login').includes('--app'));
  f.setup.finishLogin();
  const result = await operation;
  assert.equal(result.defaultModel, 'qwen-web'); assert.equal(result.sites.find(site => site.id === 'qwen').enabled, true);
  assert.deepEqual(f.bridgeCalls.map(call => call[0]), ['start']);
});

test('setup cancellation and duplicate clicks cannot save or start an unfinished account', async t => {
  const f = await fixture(t, { enabled: [], delayLogin: true });
  const operation = f.setup.connect('zai');
  await until(() => f.commands.some(command => command[0] === 'login'));
  await assert.rejects(f.setup.connect('qwen'), /already in progress/);
  await f.setup.cancel(); await assert.rejects(operation, /cancelled/);
  assert.equal(f.setup.status().busy, false); assert.equal(f.setup.status().phase, 'cancelled');
  assert.equal(f.store.data.bridgeProfiles.length, 0); assert.deepEqual(f.bridgeCalls, []);
  assert.ok(!JSON.stringify(f.setup.status()).includes(LOCAL_KEY));
});

test('startup rebases only a known bundled profile while preserving encrypted environment and provider', async t => {
  const f = await fixture(t, { dataOutside: true });
  const provider = f.store.saveProvider({ name: 'Saved website', type: 'openai', baseUrl: f.preset.provider.baseUrl, apiKey: LOCAL_KEY, models: ['zai-web'], defaultModel: 'zai-web' });
  const previousRoot = path.join(f.base, 'previous-extraction');
  const profile = f.store.saveBridgeProfile({ name: 'Saved companion', providerId: provider.id, launchMode: 'managed',
    executable: path.join(previousRoot, 'runtime', 'node.exe'), cwd: path.join(previousRoot, 'bridge'),
    args: [path.join(previousRoot, 'bridge', 'cli.mjs'), 'start', '--data-dir', f.dataDir],
    healthUrl: f.preset.bridge.healthUrl, startupTimeoutMs: 40000, env: { PRIVATE_OPTION: 'retain-me' } });
  await f.setup.prepareStartup();
  const updated = f.store.bridgeProfile(profile.id);
  assert.equal(updated.executable, f.executable); assert.equal(updated.cwd, f.cwd); assert.deepEqual(updated.args, f.preset.bridge.args);
  assert.equal(updated.env.PRIVATE_OPTION, 'retain-me'); assert.equal(updated.startupTimeoutMs, 40000);
  assert.equal(f.store.data.bridgeProfiles.length, 1); assert.deepEqual(f.bridgeCalls, []);
  assert.equal(f.store.provider(provider.id).name, 'Saved website');
});

test('startup migrates a stopped managed profile from its known previous data directory', async t => {
  const f = await fixture(t, { dataOutside: true, legacyDataDirs: true });
  const provider = f.store.saveProvider({ name: 'Saved website', type: 'openai', baseUrl: f.preset.provider.baseUrl, apiKey: LOCAL_KEY, models: ['zai-web'], defaultModel: 'zai-web' });
  const profile = f.store.saveBridgeProfile({ name: 'Saved companion', providerId: provider.id, launchMode: 'managed', executable: f.executable, cwd: f.cwd,
    args: [path.join(f.cwd, 'cli.mjs'), 'start', '--data-dir', path.join(f.root, '.data')], healthUrl: f.preset.bridge.healthUrl,
    startupTimeoutMs: 40000, env: { PRIVATE_OPTION: 'retain-me' } });
  await f.setup.prepareStartup();
  const updated = f.store.bridgeProfile(profile.id);
  assert.deepEqual(updated.args, f.preset.bridge.args); assert.equal(updated.env.PRIVATE_OPTION, 'retain-me');
  assert.equal(updated.startupTimeoutMs, 40000); assert.equal(f.store.provider(provider.id).apiKey, LOCAL_KEY);
  assert.equal(f.store.data.bridgeProfiles.length, 1); assert.deepEqual(f.bridgeCalls, []);
});

test('startup leaves external and unknown previous data profiles alone and rejects a running migration', async t => {
  for (const mode of ['external', 'unknown', 'running']) {
    const f = await fixture(t, { dataOutside: true, legacyDataDirs: true });
    const provider = f.store.saveProvider({ name: 'Saved website', type: 'openai', baseUrl: f.preset.provider.baseUrl, apiKey: LOCAL_KEY, models: ['zai-web'], defaultModel: 'zai-web' });
    const args = [path.join(f.cwd, 'cli.mjs'), 'start', '--data-dir', path.join(f.root, mode === 'unknown' ? 'unrecognized-data' : '.data')];
    const profile = f.store.saveBridgeProfile({ name: 'Saved companion', providerId: provider.id, launchMode: mode === 'external' ? 'external' : 'managed',
      executable: f.executable, cwd: f.cwd, args, healthUrl: f.preset.bridge.healthUrl, env: {} });
    if (mode === 'running') {
      f.bridges.entries.set(profile.id, { ready: true, child: { pid: 100 } });
      await assert.rejects(f.setup.prepareStartup(), /Stop the saved website bridge/);
    } else await f.setup.prepareStartup();
    assert.deepEqual(f.store.bridgeProfile(profile.id).args, args); assert.deepEqual(f.bridgeCalls, []); assert.deepEqual(f.commands, []);
  }
});

test('malformed helper endpoints and active chats are rejected before connection mutations', async t => {
  const bad = await fixture(t); bad.preset.provider.baseUrl = 'https://example.test/v1';
  await assert.rejects(bad.setup.connect('zai'), /unexpected connection/);
  assert.equal(bad.store.data.bridgeProfiles.length, 0); assert.deepEqual(bad.bridgeCalls, []);
  const busy = await fixture(t);
  const provider = busy.store.saveProvider({ name: 'Busy provider', type: 'openai', baseUrl: busy.preset.provider.baseUrl, apiKey: LOCAL_KEY, models: ['zai-web'], defaultModel: 'zai-web' });
  busy.store.data.conversations.push({ id: 'busy', providerId: provider.id, status: 'running' });
  assert.equal((await busy.setup.connect('zai')).phase, 'waiting-idle');
  assert.equal(busy.store.data.bridgeProfiles.length, 0); assert.deepEqual(busy.bridgeCalls, []);
});

test('startup does not create a provider or profile merely because companion files exist', async t => {
  const f = await fixture(t, { dataOutside: true });
  const count = f.store.data.providers.length;
  const result = await f.setup.prepareStartup();
  assert.equal(result.available, true); assert.equal(f.store.data.providers.length, count);
  assert.equal(f.store.data.bridgeProfiles.length, 0); assert.deepEqual(f.commands, []);
  assert.deepEqual(f.bridgeCalls, []);
});

test('linked private data is rejected without reading foreign credentials or starting a helper', async t => {
  const f = await fixture(t);
  const foreign = path.join(f.base, 'foreign-data'); await fs.mkdir(foreign);
  await fs.writeFile(path.join(foreign, 'config.json'), 'PRIVATE_FOREIGN_CREDENTIALS');
  const linked = path.join(f.base, 'linked-data'); await fs.symlink(foreign, linked, process.platform === 'win32' ? 'junction' : 'dir');
  f.setup.roots = [{ root: f.root, dataDir: linked }];
  const state = await f.setup.refresh();
  assert.equal(state.available, false); assert.ok(!JSON.stringify(state).includes('PRIVATE_FOREIGN_CREDENTIALS'));
  assert.deepEqual(f.commands, []);
});

test('failed website sign-in keeps the account disabled and never exposes helper account output', async t => {
  const f = await fixture(t, { enabled: [], delayLogin: true });
  const operation = f.setup.connect('chatgpt');
  await until(() => f.commands.some(command => command[0] === 'login'));
  const child = f.helperChildren.at(-1);
  child.stderr.write(`PRIVATE_WEBSITE_SESSION ${LOCAL_KEY}`); child.emit('close', 1);
  await assert.rejects(operation, /sign-in did not finish/);
  assert.equal(f.setup.status().sites.find(site => site.id === 'chatgpt').enabled, false);
  assert.equal(f.store.data.bridgeProfiles.length, 0); assert.deepEqual(f.bridgeCalls, []);
  assert.ok(!JSON.stringify(f.changes).includes('PRIVATE_WEBSITE_SESSION'));
  assert.ok(!JSON.stringify(f.changes).includes(LOCAL_KEY));
});

test('refresh forgets removed providers and startup preserves deliberately external profiles', async t => {
  const f = await fixture(t, { dataOutside: true });
  const provider = f.store.saveProvider({ name: 'External website', type: 'openai', baseUrl: f.preset.provider.baseUrl, apiKey: LOCAL_KEY, models: ['zai-web'], defaultModel: 'zai-web' });
  const profile = f.store.saveBridgeProfile({ name: 'External companion', providerId: provider.id, launchMode: 'external',
    executable: f.executable, cwd: f.cwd, args: f.preset.bridge.args, healthUrl: f.preset.bridge.healthUrl, env: {} });
  await f.setup.prepareStartup();
  assert.equal(f.store.bridgeProfile(profile.id).launchMode, 'external'); assert.deepEqual(f.commands, []);
  f.store.data.providers = f.store.data.providers.filter(item => item.id !== provider.id);
  f.store.data.bridgeProfiles = [];
  const refreshed = await f.setup.refresh();
  assert.equal(refreshed.providerId, undefined); assert.equal(refreshed.bridgeId, undefined);
});

test('refresh clears recovered runtime/configuration errors and exposes saved models at startup', async t => {
  const f = await fixture(t); const connected = await f.setup.connect('zai');
  f.setup.roots = [];
  const unavailable = await f.setup.refresh();
  assert.equal(unavailable.phase, 'error'); assert.match(unavailable.message, /built-in website service/);
  assert.ok(!unavailable.message.includes('folder beside'));
  f.setup.roots = [{ root: f.root, dataDir: f.dataDir }];
  const recovered = await f.setup.refresh();
  assert.equal(recovered.phase, 'ready'); assert.equal(recovered.error, undefined);
  assert.equal(recovered.providerId, connected.providerId); assert.deepEqual(recovered.models, ['zai-web']);
  await fs.writeFile(path.join(f.dataDir, 'config.json'), '{broken');
  assert.equal((await f.setup.refresh()).phase, 'error');
  await fs.writeFile(path.join(f.dataDir, 'config.json'), JSON.stringify(f.config));
  assert.equal((await f.setup.refresh()).phase, 'ready');
});

test('refresh hides stale routes/default selections for a disabled saved website', async t => {
  const f = await fixture(t); await f.setup.connect('zai');
  f.config.providers.zai.enabled = false;
  await fs.writeFile(path.join(f.dataDir, 'config.json'), JSON.stringify(f.config));
  const refreshed = await f.setup.refresh();
  assert.equal(refreshed.defaultModel, undefined); assert.equal(refreshed.siteId, undefined);
  assert.deepEqual(refreshed.models, []); assert.equal(refreshed.phase, 'idle');
});

test('a public refresh cannot switch the selected runtime while a sign-in operation is active', async t => {
  const f = await fixture(t, { enabled: [], delayLogin: true });
  const operation = f.setup.connect('zai');
  await until(() => f.commands.some(command => command[0] === 'login'));
  f.setup.roots = [];
  const unchanged = await f.setup.refresh();
  assert.equal(unchanged.phase, 'login'); assert.equal(unchanged.available, true);
  await f.helperChildren.at(-1).complete();
  const result = await operation;
  assert.equal(result.phase, 'ready'); assert.equal(result.defaultModel, 'zai-web');
});

test('a refresh begun before connection cannot overwrite the newer setup state', async t => {
  const f = await fixture(t);
  const read = f.setup.readFile; let release, started = false;
  f.setup.readFile = async (...args) => {
    if (!started) { started = true; return await new Promise(resolve => { release = resolve; }); }
    return read(...args);
  };
  const oldRefresh = f.setup.refresh(); await until(() => started);
  const connected = await f.setup.connect('zai');
  release('{broken stale read'); await oldRefresh;
  assert.equal(f.setup.status().phase, 'ready'); assert.equal(f.setup.status().providerId, connected.providerId);
  assert.equal(f.setup.status().error, undefined);
});

test('cancel keeps setup busy until its previous helper exits and close awaits that cleanup', async t => {
  const f = await fixture(t, { enabled: [], delayLogin: true });
  const operation = f.setup.connect('zai');
  await until(() => f.commands.some(command => command[0] === 'login'));
  const child = f.helperChildren.at(-1); child.stdin.removeAllListeners('data');
  const rejected = assert.rejects(operation, /cancelled/);
  await f.setup.cancel();
  await assert.rejects(f.setup.connect('qwen'), /already in progress/);
  let closed = false; const close = f.setup.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(closed, false);
  child.emit('close', 1); await rejected; await close;
  assert.equal(f.setup.status().busy, false); assert.deepEqual(f.bridgeCalls, []);
});

test('cancelling final model discovery stops only the service newly started by setup', async t => {
  const f = await fixture(t); const discover = f.setup.discover; let finalDiscovery = false;
  f.setup.discover = async (provider, options) => {
    if (!f.bridgeCalls.some(call => call[0] === 'start')) return discover(provider, options);
    finalDiscovery = true;
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };
  const operation = f.setup.connect('zai'); await until(() => finalDiscovery);
  const rejected = assert.rejects(operation, /cancelled/);
  await f.setup.cancel(); await rejected;
  assert.deepEqual(f.bridgeCalls.map(call => call[0]), ['start', 'stop']);
  assert.equal(f.setup.status().busy, false);
});

test('sign in again runs the human login helper even for an enabled saved site', async t => {
  const f = await fixture(t, { running: true, delayLogin: true });
  const connected = await f.setup.connect('zai');
  const operation = f.setup.connect('zai', { forceLogin: true });
  await until(() => f.commands.some(command => command[0] === 'login'));
  await f.helperChildren.at(-1).complete();
  const refreshed = await operation;
  assert.equal(refreshed.providerId, connected.providerId); assert.equal(refreshed.phase, 'ready');
  assert.ok(!f.bridgeCalls.some(call => call[0] === 'start'));
  await assert.rejects(f.setup.connect('zai', { forceLogin: 'yes' }), /true or false/);
});

test('a chat started during human sign-in prevents later connection mutations', async t => {
  const f = await fixture(t, { enabled: [], delayLogin: true });
  const provider = f.store.saveProvider({ name: 'ZLM', type: 'openai', baseUrl: f.preset.provider.baseUrl, apiKey: LOCAL_KEY, models: [], defaultModel: '' });
  const before = JSON.stringify(f.store.data.providers);
  const operation = f.setup.connect('zai');
  await until(() => f.commands.some(command => command[0] === 'login'));
  f.store.data.conversations.push({ id: 'new-chat', providerId: provider.id, status: 'running' });
  await f.helperChildren.at(-1).complete();
  assert.equal((await operation).phase, 'waiting-idle');
  assert.equal(JSON.stringify(f.store.data.providers), before);
  assert.equal(f.store.data.bridgeProfiles.length, 0); assert.deepEqual(f.bridgeCalls, []);
});

test('structured helper events survive chunk boundaries and expose only safe recovery diagnostics', async t => {
  const f = await fixture(t, { enabled: ['zai'], delayLogin: true });
  const existing = await f.setup.connect('zai');
  const operation = f.setup.connect('chatgpt');
  await until(() => f.commands.some(command => command[0] === 'login'));
  const child = f.helperChildren.at(-1);
  const event = LOGIN_EVENT_PREFIX + JSON.stringify({ version: 1, type: 'error', siteId: 'chatgpt', stage: 'checking-session', code: 'draft_present', timestamp: 100,
    token: LOCAL_KEY, url: 'https://private.test/account', message: 'PRIVATE_ACCOUNT_TEXT' }) + '\n';
  child.stdout.write(event.slice(0, 17)); child.stdout.write(event.slice(17)); child.emit('close', 1);
  await assert.rejects(operation, /restored a draft/);
  const status = f.setup.status(), diagnostic = f.setup.diagnostics();
  assert.equal(status.errorCode, 'draft_present'); assert.equal(status.recoveryAction, 'open-account');
  assert.equal(status.stage, 'checking-session'); assert.equal(f.config.providers.zai.enabled, true);
  assert.equal(f.config.providers.chatgpt.enabled, false);
  assert.deepEqual(f.bridgeCalls.map(call => call[0]), ['start']);
  assert.equal(f.bridges.entries.get(existing.bridgeId).ready, true);
  assert.ok(!JSON.stringify(diagnostic).includes(LOCAL_KEY)); assert.ok(!JSON.stringify(diagnostic).includes('PRIVATE_ACCOUNT_TEXT'));
  assert.ok(!JSON.stringify(diagnostic).includes('private.test')); assert.ok(!JSON.stringify(diagnostic).includes(f.base));
});

test('security progress distinguishes the open verification browser and cancellation settles without saving an account', async t => {
  const f = await fixture(t, { enabled: [], delayLogin: true });
  const providersBefore = structuredClone(f.store.data.providers);
  const operation = f.setup.connect('chatgpt');
  const rejected = assert.rejects(operation, /cancelled/);
  await until(() => f.commands.some(command => command[0] === 'login'));
  f.helperChildren.at(-1).stdout.write(LOGIN_EVENT_PREFIX + JSON.stringify({ version: 1, type: 'progress', siteId: 'chatgpt', stage: 'waiting-for-security-check', timestamp: 100 }) + '\n');
  const progress = f.setup.status();
  assert.equal(progress.phase, 'verifying'); assert.equal(progress.busy, true);
  assert.match(progress.message, /open verification browser.*Keep it open/);
  await f.setup.cancel(); await rejected;
  assert.equal(f.setup.status().phase, 'cancelled'); assert.equal(f.setup.status().busy, false);
  assert.match(f.setup.status().message, /cancelled/); assert.equal(f.config.providers.chatgpt.enabled, false);
  assert.deepEqual(f.store.data.providers, providersBefore); assert.deepEqual(f.bridgeCalls, []);
});

test('persistent security challenge offers Browser Connector recovery and preserves existing website services', async t => {
  const f = await fixture(t, { enabled: ['zai'], delayLogin: true });
  const existing = await f.setup.connect('zai');
  const operation = f.setup.connect('chatgpt');
  const rejected = assert.rejects(operation, /normal signed-in Chrome/);
  await until(() => f.commands.some(command => command[0] === 'login'));
  const child = f.helperChildren.at(-1);
  child.stdout.write(LOGIN_EVENT_PREFIX + JSON.stringify({ version: 1, type: 'error', siteId: 'chatgpt', stage: 'waiting-for-security-check', code: 'security_check_required', timestamp: 100 }) + '\n');
  child.emit('close', 1); await rejected;
  assert.equal(f.setup.status().recoveryAction, 'browser-connector');
  assert.equal(f.config.providers.chatgpt.enabled, false); assert.equal(f.config.providers.zai.enabled, true);
  assert.equal(f.bridges.entries.get(existing.bridgeId).ready, true);
  assert.deepEqual(f.bridgeCalls.map(call => call[0]), ['start']);
});

test('adding another account leaves the working service online until safe idle reload', async t => {
  const f = await fixture(t, { enabled: ['zai'], delayLogin: true });
  const previous = await f.setup.connect('zai');
  f.store.data.conversations.push({ id: 'working-zai', providerId: previous.providerId, model: 'zai-web', status: 'running' });
  const operation = f.setup.connect('chatgpt');
  await until(() => f.commands.some(command => command[0] === 'login'));
  assert.deepEqual(f.bridgeCalls.map(call => call[0]), ['start']);
  await f.helperChildren.at(-1).complete();
  const waiting = await operation;
  assert.equal(waiting.phase, 'waiting-idle'); assert.equal(f.bridges.entries.get(previous.bridgeId).ready, true);
  assert.equal(f.store.provider(previous.providerId).defaultModel, 'zai-web');
  f.store.data.conversations[0].status = 'complete';
  await until(() => f.setup.status().phase === 'ready' && f.setup.status().defaultModel === 'chatgpt-web');
  assert.deepEqual(f.bridgeCalls.map(call => call[0]), ['start', 'stop', 'start']);
});

test('deferred reauthentication reloads its existing model after other accounts finish', async t => {
  const f = await fixture(t, { enabled: ['zai', 'chatgpt'], delayLogin: true });
  const previous = await f.setup.connect('zai');
  f.store.data.conversations.push({ id: 'working-zai', providerId: previous.providerId, model: 'zai-web', status: 'running' });
  const operation = f.setup.connect('chatgpt', { forceLogin: true });
  await until(() => f.commands.some(command => command[0] === 'login')); await f.helperChildren.at(-1).complete();
  assert.equal((await operation).phase, 'waiting-idle');
  f.store.data.conversations[0].status = 'complete';
  await until(() => f.setup.status().phase === 'ready' && f.setup.status().defaultModel === 'chatgpt-web');
  assert.deepEqual(f.bridgeCalls.map(call => call[0]), ['start', 'stop', 'start']);
  assert.equal(f.commands.filter(command => command[0] === 'login').length, 1);
});

test('a failed deferred account reload retains the entry saved before sign-in for recovery', async t => {
  const f = await fixture(t, { enabled: ['zai'], delayLogin: true });
  const previous = await f.setup.connect('zai');
  f.store.data.conversations.push({ id: 'working-zai', providerId: previous.providerId, model: 'zai-web', status: 'running' });
  const discover = f.setup.discover; let rejectedNewService = false;
  f.setup.discover = async (provider, options) => {
    if (f.bridgeCalls.filter(call => call[0] === 'start').length === 2 && !rejectedNewService) { rejectedNewService = true; throw new Error('fixture new account service failed'); }
    return discover(provider, options);
  };
  const operation = f.setup.connect('chatgpt');
  await until(() => f.commands.some(command => command[0] === 'login')); await f.helperChildren.at(-1).complete();
  assert.equal((await operation).phase, 'waiting-idle');
  f.store.data.conversations[0].status = 'complete';
  await until(() => f.setup.status().restoredConnection === true && !f.setup.status().busy);
  assert.equal(f.config.providers.chatgpt.enabled, false); assert.equal(f.config.providers.zai.enabled, true);
  assert.equal(f.bridges.entries.get(previous.bridgeId).ready, true); assert.equal(f.store.provider(previous.providerId).defaultModel, 'zai-web');
  assert.ok(f.commands.some(command => command[0] === 'restore-site'));
});

test('cancelling a deferred idle reload keeps the working service and saved new session', async t => {
  const f = await fixture(t, { enabled: ['zai'], delayLogin: true });
  const previous = await f.setup.connect('zai');
  f.store.data.conversations.push({ id: 'working-zai', providerId: previous.providerId, model: 'zai-web', status: 'running' });
  const operation = f.setup.connect('chatgpt');
  await until(() => f.commands.some(command => command[0] === 'login')); await f.helperChildren.at(-1).complete();
  assert.equal((await operation).phase, 'waiting-idle');
  assert.equal((await f.setup.cancel()).phase, 'cancelled');
  f.store.data.conversations[0].status = 'complete';
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.deepEqual(f.bridgeCalls.map(call => call[0]), ['start']);
  assert.equal(f.config.providers.chatgpt.enabled, true); assert.equal(f.bridges.entries.get(previous.bridgeId).ready, true);
});

test('failed account reload restores only its previous entry and the owned working service', async t => {
  const f = await fixture(t, { enabled: ['zai'], delayLogin: true });
  const previous = await f.setup.connect('zai');
  const discover = f.setup.discover; let rejectedNewService = false;
  f.setup.discover = async (provider, options) => {
    if (f.bridgeCalls.filter(call => call[0] === 'start').length === 2 && !rejectedNewService) { rejectedNewService = true; throw new Error('fixture new account service failed'); }
    return discover(provider, options);
  };
  const operation = f.setup.connect('chatgpt');
  await until(() => f.commands.some(command => command[0] === 'login'));
  await f.helperChildren.at(-1).complete();
  await assert.rejects(operation, /model list could not be read/);
  assert.equal(f.config.providers.chatgpt.enabled, false); assert.equal(f.config.providers.zai.enabled, true);
  assert.equal(f.bridges.entries.get(previous.bridgeId).ready, true);
  assert.equal(f.store.provider(previous.providerId).defaultModel, 'zai-web');
  assert.equal(f.setup.status().restoredConnection, true);
  assert.ok(f.commands.some(command => command[0] === 'restore-site'));
});

test('browser preference is discovered and remembered without changing existing account browsers', async t => {
  const f = await fixture(t, { enabled: ['zai'] });
  const discovered = await f.setup.listBrowsers();
  assert.equal(discovered.browsers.length, 2); assert.ok(discovered.browsers.every(item => item.installed));
  const result = await f.setup.setBrowser('msedge');
  assert.equal(result.browserChannel, 'msedge'); assert.equal(f.config.providers.zai.browserChannel, 'chrome');
  assert.deepEqual(f.bridgeCalls, []); assert.ok(!JSON.stringify(f.setup.diagnostics()).includes(LOCAL_KEY));
});

test('remounted settings share the browser probe and Connect waits without overlapping helpers', async t => {
  const f = await fixture(t, { delayBrowsers: true });
  let firstDone = false, secondDone = false;
  const first = f.setup.listBrowsers().then(result => { firstDone = true; return result; });
  const second = f.setup.listBrowsers().then(result => { secondDone = true; return result; });
  await until(() => f.commands.some(command => command[0] === 'browsers'));
  const connection = f.setup.connect('zai');
  await assert.rejects(f.setup.connect('qwen'), /already in progress/);
  assert.equal(firstDone, false); assert.equal(secondDone, false);
  assert.equal(f.setup.status().busy, true);
  assert.deepEqual(f.commands.map(command => command[0]), ['browsers']);
  await f.helperChildren[0].complete();
  const [one, two, connected] = await Promise.all([first, second, connection]);
  assert.equal(one.browsers.length, 2); assert.equal(two.browsers.length, 2);
  assert.equal(connected.phase, 'ready'); assert.equal(connected.busy, false);
  assert.deepEqual(f.commands.map(command => command[0]), ['browsers', 'info']);
});

test('cancelling Connect during a browser probe stops the wait without saving or starting a service', async t => {
  const f = await fixture(t, { delayBrowsers: true });
  const probe = f.setup.listBrowsers(); const probeRejected = assert.rejects(probe, /cancelled/);
  await until(() => f.commands.some(command => command[0] === 'browsers'));
  const connectionRejected = assert.rejects(f.setup.connect('zai'), /cancelled/);
  await f.setup.cancel(); await Promise.all([probeRejected, connectionRejected]);
  assert.equal(f.setup.child, null); assert.equal(f.setup.status().busy, false);
  assert.deepEqual(f.bridgeCalls, []); assert.equal(f.store.data.bridgeProfiles.length, 0);
});

test('closing during a read-only browser probe cancels queued Connect and launches no new helper', async t => {
  const f = await fixture(t, { delayBrowsers: true });
  const probeRejected = assert.rejects(f.setup.listBrowsers(), /cancelled/);
  await until(() => f.commands.some(command => command[0] === 'browsers'));
  const connectionRejected = assert.rejects(f.setup.connect('zai'), /cancelled/);
  await f.setup.close(); await Promise.all([probeRejected, connectionRejected]);
  assert.equal(f.setup.child, null); assert.equal(f.setup.operation, null);
  assert.deepEqual(f.commands.map(command => command[0]), ['browsers']);
  assert.deepEqual(f.bridgeCalls, []);
  await f.setup.listBrowsers(); assert.equal(f.commands.length, 1);
  await assert.rejects(f.setup.connect('zai'), /shutting down/);
});

test('a timed-out read-only browser probe is bounded and releases the helper before Connect', async t => {
  const f = await fixture(t, { delayBrowsers: true });
  f.setup.helperTimeoutMs = 20; f.setup.helperCloseTimeoutMs = 30;
  const probeRejected = assert.rejects(f.setup.listBrowsers(), /timed out/);
  await until(() => f.commands.some(command => command[0] === 'browsers'));
  const connected = await f.setup.connect('zai'); await probeRejected;
  assert.equal(connected.phase, 'ready'); assert.equal(connected.busy, false);
  assert.deepEqual(f.commands.map(command => command[0]), ['browsers', 'info']);
});

test('reauthentication releases only an owned selected account browser without stopping other websites', async t => {
  const f = await fixture(t, { enabled: ['zai', 'chatgpt'], delayLogin: true });
  const previous = await f.setup.connect('zai'); f.profileOpenSites.add('chatgpt'); f.profileOpenSites.add('zai');
  const operation = f.setup.connect('chatgpt', { forceLogin: true });
  await until(() => f.commands.some(command => command[0] === 'login'));
  assert.equal(f.profileOpenSites.has('chatgpt'), false); assert.equal(f.profileOpenSites.has('zai'), true);
  assert.deepEqual(f.bridgeCalls.map(call => call[0]), ['start']);
  f.helperChildren.at(-1).emit('close', 1); await assert.rejects(operation, /sign-in did not finish/);
  assert.equal(f.bridges.entries.get(previous.bridgeId).ready, true); assert.equal(f.config.providers.zai.enabled, true);
});
