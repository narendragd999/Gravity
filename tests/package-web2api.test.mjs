import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { packageWeb2Api } from '../scripts/package-web2api.mjs';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gravity-web2api-package-'));
  assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir()));
  const files = new Set(), directories = new Set([base]);
  const rememberDirectory = directory => {
    for (let current = directory; current !== base; current = path.dirname(current)) {
      assert.ok(path.relative(base, current) && !path.relative(base, current).startsWith('..'));
      directories.add(current);
    }
  };
  const write = async (file, text = 'fixture') => { rememberDirectory(path.dirname(file)); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); files.add(file); };
  const rememberOutput = result => { for (const relative of result.files) { const file = path.join(result.outputDir, relative); files.add(file); rememberDirectory(path.dirname(file)); } };
  t.after(async () => {
    // Remove only registered disposable fixture paths, without recursive delete.
    for (const file of [...files].sort((a, b) => b.length - a.length)) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) await fs.rmdir(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
  });
  const sourceRoot = path.join(base, 'source'), bridge = path.join(sourceRoot, 'bridges', 'multi-web2api'), outputDir = path.join(base, 'sidecar');
  const roots = ['cli.mjs', 'config.mjs', 'manual-login.mjs', 'login-events.mjs', 'server.mjs', 'protocol.mjs', 'package-lock.json', 'README.md', 'LICENSE', 'THIRD_PARTY.md', 'WINDOWS.md'];
  for (const file of roots) await write(path.join(bridge, file), `fixture ${file}`);
  await write(path.join(bridge, 'package.json'), JSON.stringify({ name: 'gravity-multi-web2api', dependencies: { 'playwright-core': '1.64.1' } }));
  for (const file of ['browser.mjs', 'browser-stream.mjs', 'direct-http.mjs', 'deepseek.mjs', 'qwen.mjs', 'deepseek-pow.mjs', 'deepseek-pow-worker.mjs']) await write(path.join(bridge, 'adapters', file), `export const fixture = ${JSON.stringify(file)};`);
  for (const file of ['README.md', 'LICENSE.FreeTokenAPI', 'LICENSE.tab2api', 'LICENSE.glm-proxy', 'deepseek-sha3.wasm']) await write(path.join(bridge, 'adapters', 'vendor', file), `vendor ${file}`);
  const driver = path.join(bridge, 'node_modules', 'playwright-core');
  await write(path.join(driver, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.64.1' }));
  for (const file of ['LICENSE', 'NOTICE', 'ThirdPartyNotices.txt', 'index.js', 'index.mjs', 'lib/server.js']) await write(path.join(driver, file), `driver ${file}`);
  const nodePath = path.join(base, 'node-install', 'node.exe'); await write(nodePath, 'fixture Windows Node runtime'); await write(path.join(base, 'node-install', 'LICENSE'), 'matching Node license');
  return { base, sourceRoot, bridge, outputDir, driver, nodePath, write, files, directories, rememberDirectory, rememberOutput };
}

async function tree(directory, prefix = '') {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await tree(path.join(directory, entry.name), relative)); else result.push(relative);
  }
  return result.sort();
}

test('sidecar packages curated sources, pinned driver, runtime and stable manual launchers', async t => {
  const f = await fixture(t);
  f.outputDir = path.join(f.base, 'sidecar with ! spaces');
  await f.write(path.join(f.bridge, '.data', 'config.json'), 'PRIVATE_WEBSITE_TOKEN');
  await f.write(path.join(f.bridge, '.data', 'browsers', 'chatgpt', 'Cookies'), 'PRIVATE_BROWSER_PROFILE');
  await f.write(path.join(f.bridge, 'config.json'), 'PRIVATE_WEBSITE_TOKEN');
  await f.write(path.join(f.bridge, 'cookies.txt'), 'PRIVATE_COOKIE');
  await f.write(path.join(f.bridge, '.env'), 'PRIVATE_ENV');
  await f.write(path.join(f.bridge, 'adapters', 'secrets.json'), 'PRIVATE_ADAPTER_SECRET');
  await f.write(path.join(f.bridge, 'node_modules', 'unrelated-global', 'index.js'), 'UNRELATED_MODULE');
  await f.write(path.join(f.driver, '.data', 'state.json'), 'PRIVATE_DRIVER_STATE');
  await f.write(path.join(path.dirname(f.nodePath), 'node_modules', 'global-secret', 'index.js'), 'GLOBAL_MODULE');
  await f.write(path.join(path.dirname(f.nodePath), 'vcruntime140.dll'), 'DLL_NOT_REQUESTED');
  const result = await packageWeb2Api(f); f.rememberOutput(result);
  assert.deepEqual(await tree(f.outputDir), result.files);
  assert.equal(await fs.readFile(path.join(f.outputDir, 'README.md'), 'utf8'), 'fixture WINDOWS.md');
  assert.equal(await fs.readFile(path.join(f.outputDir, 'bridge', 'WINDOWS.md'), 'utf8'), 'fixture WINDOWS.md');
  assert.equal(await fs.readFile(path.join(f.outputDir, 'runtime', 'node.exe'), 'utf8'), 'fixture Windows Node runtime');
  assert.equal(await fs.readFile(path.join(f.outputDir, 'runtime', 'LICENSE'), 'utf8'), 'matching Node license');
  assert.ok(result.files.includes('bridge/adapters/vendor/deepseek-sha3.wasm'));
  assert.ok(result.files.includes('bridge/manual-login.mjs'));
  assert.ok(result.files.includes('bridge/node_modules/playwright-core/NOTICE'));
  assert.ok(!result.files.some(file => /\.data|config\.json|cookies|\.env|secrets\.json|unrelated-global|global-secret|\.dll$/i.test(file)));
  const expected = new Map([['Setup', 'setup'], ['Start', 'start'], ['Info', 'info'], ['Models', 'models'], ['Status', 'status'], ['Login-DeepSeek', 'login deepseek'], ['Login-Qwen', 'login qwen'], ['Login-ChatGPT', 'login chatgpt'], ['Login-Zai', 'login zai']]);
  for (const [name, command] of expected) {
    const text = await fs.readFile(path.join(f.outputDir, `${name}.cmd`), 'utf8');
    assert.ok(text.includes('setlocal DisableDelayedExpansion'));
    assert.ok(text.includes(`"%~dp0runtime\\node.exe" "%~dp0bridge\\cli.mjs" ${command} --data-dir "%~dp0.data"`));
    assert.ok(text.indexOf('set "GRAVITY_WEB2API_EXIT=%ERRORLEVEL%"') < text.indexOf('pause'));
    assert.match(text, /exit \/b %GRAVITY_WEB2API_EXIT%/);
  }
});

test('repackaging preserves existing private data without including it in inventory', async t => {
  const f = await fixture(t);
  const dataFile = path.join(f.outputDir, '.data', 'browsers', 'chatgpt', 'Cookies');
  await f.write(dataFile, 'KEEP_THIS_SESSION');
  let result = await packageWeb2Api(f); f.rememberOutput(result);
  await f.write(path.join(f.bridge, 'cli.mjs'), 'updated bridge');
  result = await packageWeb2Api(f); f.rememberOutput(result);
  assert.equal(await fs.readFile(dataFile, 'utf8'), 'KEEP_THIS_SESSION');
  assert.equal(await fs.readFile(path.join(f.outputDir, 'bridge', 'cli.mjs'), 'utf8'), 'updated bridge');
  assert.ok(!result.files.some(file => file.startsWith('.data/')));
});

test('sidecar rejects linked source adapter directories and leaves destination untouched', async t => {
  const f = await fixture(t);
  const foreign = path.join(f.base, 'foreign'); await f.write(path.join(foreign, 'private.txt'), 'PRIVATE_LINK_TARGET');
  const link = path.join(f.bridge, 'adapters', 'linked');
  await fs.symlink(foreign, link, process.platform === 'win32' ? 'junction' : 'dir'); f.files.add(link);
  await assert.rejects(packageWeb2Api(f), /Linked Web2API source entry/);
  assert.equal(await fs.stat(f.outputDir).then(() => true, () => false), false);
});

test('sidecar rejects linked destinations, linked .data and linked destination ancestors', async t => {
  for (const mode of ['destination', 'data', 'ancestor']) {
    const f = await fixture(t); const foreign = path.join(f.base, `foreign-${mode}`);
    await f.write(path.join(foreign, 'private.txt'), 'KEEP_LINK_TARGET');
    let outputDir = f.outputDir;
    const link = mode === 'destination' ? outputDir : mode === 'data' ? path.join(outputDir, '.data') : path.join(f.base, 'linked-parent');
    if (mode === 'data') { await fs.mkdir(outputDir); f.directories.add(outputDir); }
    if (mode === 'ancestor') outputDir = path.join(link, 'sidecar');
    await fs.symlink(foreign, link, process.platform === 'win32' ? 'junction' : 'dir'); f.files.add(link);
    await assert.rejects(packageWeb2Api({ ...f, outputDir }), /destination|traverse links/i);
    assert.equal(await fs.readFile(path.join(foreign, 'private.txt'), 'utf8'), 'KEEP_LINK_TARGET');
    assert.deepEqual(await fs.readdir(foreign), ['private.txt']);
  }
});

test('sidecar refuses unpinned drivers and missing Node licenses before publishing', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.driver, 'package.json'), JSON.stringify({ name: 'playwright-core', version: 'wrong' }));
  await assert.rejects(packageWeb2Api(f), /exact pinned/);
  await f.write(path.join(f.driver, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.64.1' }));
  const license = path.join(path.dirname(f.nodePath), 'LICENSE'); await fs.unlink(license); f.files.delete(license);
  await assert.rejects(packageWeb2Api(f), { code: 'ENOENT' });
  assert.equal(await fs.stat(f.outputDir).then(() => true, () => false), false);
});

test('sidecar refuses unexpected stale release files instead of deleting them', async t => {
  const f = await fixture(t); const stale = path.join(f.outputDir, 'secrets.json'); await f.write(stale, 'PRESERVE_STALE_FILE');
  await assert.rejects(packageWeb2Api(f), /Unexpected existing/);
  assert.equal(await fs.readFile(stale, 'utf8'), 'PRESERVE_STALE_FILE');
});
