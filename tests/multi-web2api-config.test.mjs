import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, saveConfig, updateConfig, validateConfig } from '../bridges/multi-web2api/config.mjs';
import { buildAdapters, createLoginTokenCapture, discoverAccountModels, gravityPreset } from '../bridges/multi-web2api/cli.mjs';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../bridges/multi-web2api/cli.mjs', import.meta.url));
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gravity-web2api-config-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('gravity-web2api-config-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('concurrent first setup publishes exactly one private local token', async t => {
  const directory = await temporary(t);
  const configs = await Promise.all(Array.from({ length: 24 }, () => loadConfig(directory, {})));
  assert.equal(new Set(configs.map(config => config.apiToken)).size, 1);
  assert.match(configs[0].apiToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(configs[0].port, 4320);
  assert.ok(Object.values(configs[0].providers).every(provider => provider.enabled === false));
  assert.deepEqual(await fs.readdir(directory), ['config.json']);
});

test('portable filesystems without hard links publish one complete configuration across processes', async t => {
  const directory = await temporary(t);
  const moduleUrl = new URL('../bridges/multi-web2api/config.mjs', import.meta.url).href;
  const script = `
    import fs from 'node:fs/promises';
    const { loadConfig } = await import(process.argv[1]);
    fs.link = async () => { throw Object.assign(new Error('Fixture filesystem has no hard links'), { code: process.argv[3] }); };
    const config = await loadConfig(process.argv[2], {});
    process.stdout.write(config.apiToken);
  `;
  const creators = Promise.all(Array.from({ length: 8 }, (_, index) => run(process.execPath,
    ['--input-type=module', '-e', script, moduleUrl, directory, index % 2 ? 'EPERM' : 'ENOTSUP'])));
  let checking = true, reads = 0;
  const reader = (async () => {
    while (checking) {
      try {
        const config = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
        validateConfig(config); reads++;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await delay(1);
    }
  })();
  let results;
  try { results = await creators; }
  finally { checking = false; await reader; }
  assert.equal(new Set(results.map(result => result.stdout)).size, 1);
  assert.equal((await loadConfig(directory, {})).apiToken, results[0].stdout);
  assert.ok(reads > 0, 'concurrent readers observed a complete configuration');
  assert.deepEqual(await fs.readdir(directory), ['config.json']);
});

test('portable publication preserves existing configuration and propagates unrelated storage errors', async t => {
  const directory = await temporary(t);
  const config = await loadConfig(directory, {});
  const file = path.join(directory, 'config.json');
  const original = await fs.readFile(file, 'utf8');
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('Fixture hard links unavailable'), { code: 'ENOTSUP' }); });
  await assert.rejects(saveConfig(directory, { ...config, port: 4321 }, { exclusive: true }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(file, 'utf8'), original);
  const failedDirectory = path.join(directory, 'storage-error');
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('Fixture storage failure'), { code: 'EIO' }); });
  await assert.rejects(saveConfig(failedDirectory, config, { exclusive: true }), { code: 'EIO' });
  assert.deepEqual(await fs.readdir(failedDirectory), []);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['config.json', 'storage-error']);
});

test('invalid configuration never replaces the last usable configuration', async t => {
  const directory = await temporary(t);
  const config = await loadConfig(directory, {});
  const original = await fs.readFile(path.join(directory, 'config.json'), 'utf8');
  for (const changes of [ { port: 80 }, { apiToken: 'short' }, { browserChannel: 'chromium' }, { ignoredTypo: true },
    { providers: { qwen: { enabled: true, token: 'token;cookie=other' } } },
    { providers: { chatgpt: { enabled: true, token: 'fixture-private-token' } } },
    { providers: { zai: { enabled: true, upstreamModel: 'unavailable-model' } } } ]) {
    await assert.rejects(saveConfig(directory, { ...config, ...changes }));
    assert.equal(await fs.readFile(path.join(directory, 'config.json'), 'utf8'), original);
  }
  assert.throws(() => validateConfig({ ...config, providers: { qwen: { enabled: true, token: '\nsecret' } } }));
});

test('replacement config writes never expose partial JSON to concurrent readers', async t => {
  const directory = await temporary(t);
  const config = await loadConfig(directory, {});
  await Promise.all([
    (async () => { for (let i = 0; i < 20; i++) await saveConfig(directory, { ...config, port: 4320 + i }); })(),
    (async () => { for (let i = 0; i < 60; i++) assert.equal((await loadConfig(directory, {})).apiToken, config.apiToken); })(),
  ]);
  assert.deepEqual(await fs.readdir(directory), ['config.json']);
});

test('provider setup merges concurrent changes and excludes environment-only tokens', async t => {
  const directory = await temporary(t);
  await loadConfig(directory, {});
  const envConfig = await loadConfig(directory, { GRAVITY_QWEN_TOKEN: 'fixture-env-token' });
  assert.equal(envConfig.providers.qwen.enabled, true);
  assert.equal((await loadConfig(directory, {})).providers.qwen.token, undefined);
  await Promise.all(['deepseek', 'qwen', 'chatgpt', 'zai'].map(id => updateConfig(directory, async current => {
    await delay(10);
    current.providers[id].enabled = true;
  })));
  const disk = await loadConfig(directory, {});
  assert.ok(Object.values(disk.providers).every(provider => provider.enabled));
  assert.equal(disk.providers.qwen.token, undefined);
  assert.deepEqual(await fs.readdir(directory), ['config.json']);
});

test('corrupt or redirected configuration is rejected without replacing it', async t => {
  const directory = await temporary(t);
  const file = path.join(directory, 'config.json');
  await fs.writeFile(file, '{broken');
  await assert.rejects(loadConfig(directory, {}), /Cannot read/);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
  const linked = path.join(directory, 'linked');
  const target = path.join(directory, 'target');
  await fs.mkdir(target);
  await fs.symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(loadConfig(linked, {}), /links/);
  assert.deepEqual(await fs.readdir(target), []);
});

test('login collector waits for headers and ignores older, unrelated, or malformed tokens', async () => {
  const collector = createLoginTokenCapture('qwen');
  const request = (url, token, milliseconds = 0) => ({ url: () => url, allHeaders: async () => {
    await delay(milliseconds); return { authorization: `Bearer ${token}` };
  } });
  collector.capture(request('https://chat.qwen.ai/api/v1/auths/', 'fixture-older-session-token', 30));
  collector.capture(request('https://chat.qwen.ai/api/v2/models/', 'fixture-newer-session-token', 5));
  collector.capture(request('https://example.com/api/v1/auths/', 'fixture-foreign-session-token'));
  collector.capture(request('https://chat.qwen.ai/not-api', 'fixture-wrong-path-token'));
  collector.capture(request('https://chat.qwen.ai/api/test', 'invalid;cookie=token'));
  await collector.settle();
  assert.equal(collector.token, 'fixture-newer-session-token');
  const browserCollector = createLoginTokenCapture('chatgpt');
  browserCollector.capture(request('https://chatgpt.com/api/test', 'fixture-must-not-extract-token'));
  await browserCollector.settle();
  assert.equal(browserCollector.token, undefined);
});

test('Gravity preset contains only the local key and exact managed Node launch fields', async t => {
  const directory = await temporary(t);
  const config = await loadConfig(directory, { GRAVITY_DEEPSEEK_TOKEN: 'fixture-website-private-token' });
  const preset = gravityPreset(config, directory);
  assert.equal(preset.provider.baseUrl, 'http://127.0.0.1:4320/v1');
  assert.equal(preset.provider.apiKey, config.apiToken);
  assert.equal(preset.bridge.executable, process.execPath);
  assert.deepEqual(preset.bridge.args, [cli, 'start', '--data-dir', directory]);
  assert.equal(preset.bridge.healthUrl, 'http://127.0.0.1:4320/health');
  assert.equal(JSON.stringify(preset).includes('fixture-website-private-token'), false);
});

test('direct token configuration constructs adapters without opening any browser', async t => {
  const directory = await temporary(t);
  const config = await loadConfig(directory, { GRAVITY_DEEPSEEK_TOKEN: 'fixture-deepseek-token', GRAVITY_QWEN_TOKEN: 'fixture-qwen-token' });
  assert.deepEqual(buildAdapters(config, directory).map(adapter => adapter.id), ['deepseek', 'qwen']);
  assert.deepEqual(await fs.readdir(directory), ['config.json']);
  config.providers.qwen.token = undefined;
  assert.throws(() => buildAdapters(config, directory), /Browser login is optional/);
});

test('model discovery completes before returning aliases and propagates cancellation', async () => {
  const signal = new AbortController().signal;
  const adapter = { models: [], async discoverModels(options) {
    assert.equal(options.signal, signal); await delay(10); this.models = [{ id: 'account-web' }];
  } };
  assert.deepEqual((await discoverAccountModels([adapter], signal))[0].models, [{ id: 'account-web' }]);
  await assert.rejects(discoverAccountModels([{ async discoverModels() { throw new Error('fixture unavailable'); } }], signal), /unavailable/);
});

test('CLI setup/help/info separate account probes from automated tests and do not enable accounts', async t => {
  const directory = await temporary(t);
  const env = { ...process.env, GRAVITY_DEEPSEEK_TOKEN: '', GRAVITY_QWEN_TOKEN: '' };
  const help = await run(process.execPath, [cli, '--help', '--data-dir', directory], { env });
  assert.match(help.stdout, /probe <model-id>/);
  assert.deepEqual(await fs.readdir(directory), []);
  const setup = await run(process.execPath, [cli, 'setup', '--data-dir', directory], { env });
  assert.match(setup.stdout, /Browser login is optional/);
  const info = await run(process.execPath, [cli, 'info', '--json', '--data-dir', directory], { env });
  assert.equal(JSON.parse(info.stdout).provider.type, 'openai');
  const config = await loadConfig(directory, {});
  assert.ok(Object.values(config.providers).every(provider => !provider.enabled));
  await assert.rejects(run(process.execPath, [cli, 'test', '--data-dir', directory], { env }), error => /account inference uses npm run probe/.test(error.stderr));
});
