import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { copyBrowserExtension, prepareBrowserExtensionFolders } from '../electron/extension-files.mjs';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(import.meta.resolve('electron-builder'));
const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
const asar = libraryRequire('@electron/asar');

async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await files(path.join(directory, entry.name), relative));
    else result.push(relative);
  }
  return result.sort();
}

test('packaged browser extension extracts from ASAR into a Chrome-loadable folder', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-extension-setup-'));
  t.after(async () => {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const appSource = path.join(temporary, 'app');
  const source = path.join(appSource, 'browser-extension');
  await fs.cp(fileURLToPath(new URL('../browser-extension', import.meta.url)), source, { recursive: true });
  await fs.mkdir(path.join(source, 'assets'));
  await fs.writeFile(path.join(source, 'assets/icon.bin'), Buffer.from([0, 1, 127, 128, 255]));
  const archive = path.join(temporary, 'app.asar');
  await asar.createPackage(appSource, archive);
  const destination = path.join(temporary, 'prepared extension');
  // A failed setup in the old release leaves this versioned folder empty.
  await fs.mkdir(destination);
  const script = `
    (async () => {
      const { copyBrowserExtension } = await import(${JSON.stringify(new URL('../electron/extension-files.mjs', import.meta.url).href)});
      await copyBrowserExtension(${JSON.stringify(path.join(archive, 'browser-extension'))}, ${JSON.stringify(destination)});
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(require('electron'), ['-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true, encoding: 'utf8', timeout: 30000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const sourceFiles = await files(source);
  assert.deepEqual(await files(destination), sourceFiles, 'Every packaged extension asset is extracted');
  for (const relative of sourceFiles) {
    assert.deepEqual(await fs.readFile(path.join(destination, relative)), await fs.readFile(path.join(source, relative)), relative);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(destination, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(sourceFiles.includes(path.normalize(manifest.background.service_worker)));
  assert.ok(sourceFiles.includes(path.normalize(manifest.action.default_popup)));
});

test('extension setup updates recognized old install folders and keeps a stable current path', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-extension-upgrade-'));
  t.after(async () => { assert.equal(path.dirname(temporary), path.resolve(os.tmpdir())); await fs.rm(temporary, { recursive: true, force: true }); });
  const source = fileURLToPath(new URL('../browser-extension', import.meta.url));
  const base = path.join(temporary, 'browser-extension');
  for (const version of ['1.3.0', '1.4.1', '1.4.2']) {
    const folder = path.join(base, version); await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify({ name: 'Antigravity Studio Browser Connector', version: '1.0.0' }));
    await fs.writeFile(path.join(folder, 'background.mjs'), 'OLD EXTENSION');
  }
  const other = path.join(base, '2.0.0'); await fs.mkdir(other);
  const foreignManifest = JSON.stringify({ name: 'Unrelated extension', version: '2.0.0' });
  await fs.writeFile(path.join(other, 'manifest.json'), foreignManifest);
  const first = await prepareBrowserExtensionFolders(source, base);
  assert.equal(first.path, path.join(base, 'current')); assert.equal(first.updatedPaths.length, 3);
  for (const folder of [first.path, ...first.updatedPaths]) {
    assert.deepEqual(await fs.readFile(path.join(folder, 'background.mjs')), await fs.readFile(path.join(source, 'background.mjs')));
    assert.deepEqual(await fs.readFile(path.join(folder, 'manifest.json')), await fs.readFile(path.join(source, 'manifest.json')));
  }
  assert.equal(await fs.readFile(path.join(other, 'manifest.json'), 'utf8'), foreignManifest);
  const next = await prepareBrowserExtensionFolders(source, base);
  assert.equal(next.path, first.path, 'Installing a later desktop version does not change the Chrome install path');
});

test('extension copy refuses a redirected destination without changing its target', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-extension-redirect-'));
  t.after(async () => { assert.equal(path.dirname(temporary), path.resolve(os.tmpdir())); await fs.rm(temporary, { recursive: true, force: true }); });
  const target = path.join(temporary, 'outside'), link = path.join(temporary, 'linked-install');
  await fs.mkdir(target); await fs.writeFile(path.join(target, 'keep.txt'), 'untouched');
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(copyBrowserExtension(fileURLToPath(new URL('../browser-extension', import.meta.url)), link), /regular folder/);
  assert.deepEqual(await fs.readdir(target), ['keep.txt']);
});
