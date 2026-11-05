import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const { version } = sourcePackage;
assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, 'Invalid artifact version');
assert.equal(sourcePackage.build.productName, 'Gravity', 'Distribution product name must be Gravity');
// Resolve through electron-builder so this works with pnpm's isolated dependencies.
const builderRequire = createRequire(import.meta.resolve('electron-builder'));
const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
const asar = libraryRequire('@electron/asar');
const archive = path.join(root, 'release/win-unpacked/resources/app.asar');
const forbidden = /(?:^|\/)(?:cookie[^/]*\.(?:txt|json)|state\.json|bridge-runtime\.json|credentials\.json|auth\.json|config\.json|tests|node_modules|\.git|\.data|\.downloads|__pycache__|\.env[^/]*)(?:\/|$)|\.(?:log|pyc|pyo|pem|key|p12|pfx)$/i;

function regularFile(relative) {
  const filename = path.join(root, relative);
  assert.ok(fs.lstatSync(filename).isFile(), `Expected a regular file: ${relative}`);
  assert.equal(fs.realpathSync(filename).toLowerCase(), path.resolve(filename).toLowerCase(), `Redirected package input: ${relative}`);
  assert.ok(!forbidden.test(relative), `Credential or runtime path must not be packaged: ${relative}`);
  return filename;
}

function collect(directory) {
  const absolute = path.join(root, directory);
  assert.ok(fs.lstatSync(absolute).isDirectory(), `Expected a regular directory: ${directory}`);
  assert.equal(fs.realpathSync(absolute).toLowerCase(), path.resolve(absolute).toLowerCase(), `Redirected package input: ${directory}`);
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    const relative = `${directory}/${entry.name}`;
    assert.ok(!forbidden.test(relative), `Credential or runtime path must not be packaged: ${relative}`);
    return entry.isDirectory() ? collect(relative) : [relative];
  });
}

const expected = [
  ...collect('dist'), ...collect('electron'), ...collect('browser-extension'), 'build/icon.ico',
  'LICENSE', 'THIRD_PARTY.md', 'THIRD_PARTY_LICENSES.txt', 'package.json', 'bridges/multi-web2api/login-events.mjs',
].sort();
const packaged = [];
for (const entry of asar.listPackage(archive)) {
  const relative = entry.replaceAll('\\', '/').replace(/^\//, '');
  assert.ok(!forbidden.test(relative), `Unexpected credential or runtime path: ${relative}`);
  const stat = asar.statFile(archive, path.normalize(relative), false);
  assert.ok(!stat.link && !stat.unpacked, `Unexpected linked or unpacked file: ${relative}`);
  if (!stat.files) packaged.push(relative);
}
assert.deepEqual(packaged.sort(), expected, 'Packaged file inventory differs from current build inputs');
for (const relative of expected) {
  const filename = regularFile(relative);
  if (relative === 'package.json') continue;
  assert.ok(asar.extractFile(archive, path.normalize(relative)).equals(fs.readFileSync(filename)), `Packaged content differs: ${relative}`);
}
// Electron-builder intentionally removes build-only metadata from package.json.
const { scripts, devDependencies, build, ...expectedPackage } = sourcePackage;
assert.deepEqual(JSON.parse(asar.extractFile(archive, 'package.json')), expectedPackage, 'Packaged package.json differs');
// The portable executable wraps this directory, so verify its bundled runtime
// as well as app.asar. A launch must not depend on system Node or a source tree.
for (const relative of ['Gravity.exe', 'icudtl.dat', 'resources.pak', 'LICENSE.electron.txt', 'LICENSES.chromium.html']) {
  regularFile(`release/win-unpacked/${relative}`);
}
const extensionManifest = JSON.parse(asar.extractFile(archive, path.normalize('browser-extension/manifest.json')));
assert.equal(extensionManifest.name, 'Gravity Browser Connector');
assert.ok(packaged.includes(`browser-extension/${extensionManifest.background.service_worker}`), 'Bundled extension worker is missing');
assert.ok(packaged.includes(`browser-extension/${extensionManifest.action.default_popup}`), 'Bundled extension popup is missing');

// The website service is outside ASAR because its bundled Node runtime executes
// it directly. Compare the curated companion files byte-for-byte; .data remains
// private and is never copied into the executable.
function externalFiles(directory, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    assert.equal(fs.lstatSync(filename).isSymbolicLink(), false, 'Website resources must not follow links');
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.ok(!/(?:^|\/)(?:\.data|\.env[^/]*|cookie[^/]*\.(?:json|txt)|state\.json|config\.json|credentials\.json)(?:\/|$)/i.test(relative), 'Private website data must not be bundled');
    if (entry.isDirectory()) result.push(...externalFiles(filename, relative)); else result.push(relative);
  }
  return result.sort();
}
for (const directory of ['runtime', 'bridge']) {
  const source = path.join(root, 'release', 'web2api-build', directory);
  const bundled = path.join(root, 'release', 'win-unpacked', 'resources', 'web2api', directory);
  const inventory = externalFiles(source);
  assert.deepEqual(externalFiles(bundled), inventory, 'Bundled website service inventory differs');
  for (const relative of inventory) assert.ok(fs.readFileSync(path.join(source, relative)).equals(fs.readFileSync(path.join(bundled, relative))), `Website resource differs: ${directory}/${relative}`);
}

// Verification must not silently replace an outdated source archive.
const pythonCandidates = process.env.PYTHON ? [process.env.PYTHON] : ['python', 'python3'];
let verification;
for (const python of pythonCandidates) {
  verification = spawnSync(python, [path.join(root, 'scripts/source-archive.py'), '--verify-only'], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
  if (verification.error?.code !== 'ENOENT') break;
}
if (verification?.error) throw verification.error;
assert.equal(verification?.status, 0, 'Source ZIP verification failed (Python 3 is required)');

const targets = [`Gravity-${version}-x64.exe`, `Gravity-${version}-source.zip`];
const hashes = targets.map(name => {
  const filename = regularFile(`release/${name}`);
  return `${createHash('sha256').update(fs.readFileSync(filename)).digest('hex')}  ${name}`;
}).join('\n') + '\n';
fs.writeFileSync(path.join(root, `release/SHA256SUMS-${version}.txt`), hashes);
console.log('PASS: packaged app and source ZIP match current inputs; credential and runtime paths excluded; icon and license notices verified.');
console.log(hashes);
