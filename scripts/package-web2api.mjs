import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeFiles = ['cli.mjs', 'config.mjs', 'manual-login.mjs', 'login-events.mjs', 'server.mjs', 'protocol.mjs', 'package.json', 'package-lock.json', 'README.md', 'WINDOWS.md', 'LICENSE', 'THIRD_PARTY.md',
  'adapters/browser.mjs', 'adapters/browser-stream.mjs', 'adapters/direct-http.mjs', 'adapters/deepseek.mjs', 'adapters/qwen.mjs', 'adapters/deepseek-pow.mjs', 'adapters/deepseek-pow-worker.mjs',
  'adapters/vendor/README.md', 'adapters/vendor/LICENSE.FreeTokenAPI', 'adapters/vendor/LICENSE.tab2api', 'adapters/vendor/LICENSE.glm-proxy', 'adapters/vendor/deepseek-sha3.wasm'];
const privateName = name => /^(?:\.data|\.git|\.env.*|\.downloads|\.local-browsers|\.cache|__pycache__|\.venv|venv|node_modules|(?:config|auth|state|credentials|secrets?|tokens?|sessions?|cookies?|bridge-runtime)\.(?:json|txt))$/i.test(name) || /\.(?:log|pyc|pyo|pem|key|p12|pfx)$/i.test(name);
const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const inside = (target, root) => { const relative = path.relative(root, target); return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };

async function statIfExists(filename) {
  try { return await fs.lstat(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}
async function regularFile(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Web2API package input must be a regular file: ${filename}`);
  return stat;
}
async function regularDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || normalize(await fs.realpath(directory)) !== normalize(directory)) throw new Error(`Web2API package directory must not follow links or junctions: ${directory}`);
}
async function destinationAncestors(directory) {
  let current = path.parse(directory).root;
  for (const segment of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await statIfExists(current);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Web2API destination must not traverse links or non-directories: ${current}`);
  }
}

// Examine entry types, never the contents of private runtime/session folders.
async function validateBridgeEntries(directory, recursive = false) {
  await regularDirectory(directory);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink()) throw new Error(`Linked Web2API source entry is not allowed: ${filename}`);
    if (stat.isDirectory() && !privateName(entry.name) && (recursive || entry.name === 'adapters')) await validateBridgeEntries(filename, true);
  }
}
async function driverInventory(directory, prefix = '') {
  await regularDirectory(directory);
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink()) throw new Error(`Linked browser-driver entry is not allowed: ${filename}`);
    if (privateName(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (stat.isDirectory()) files.push(...await driverInventory(filename, relative));
    else { await regularFile(filename); files.push({ source: filename, relative }); }
  }
  return files;
}

async function validateExistingDestination(directory, allowed, prefix = '') {
  const stat = await statIfExists(directory);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Web2API destination must be a regular directory: ${directory}`);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    const info = await fs.lstat(filename);
    if (info.isSymbolicLink()) throw new Error(`Linked Web2API destination is not allowed: ${filename}`);
    if (!prefix && entry.name === '.data') {
      if (!info.isDirectory()) throw new Error('Existing Web2API .data must be a regular directory.');
      continue; // Preserve all session data without inspecting it.
    }
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (info.isDirectory()) {
      if (![...allowed].some(name => name.startsWith(`${relative}/`))) throw new Error(`Unexpected existing Web2API destination entry: ${relative}`);
      await validateExistingDestination(filename, allowed, relative);
    } else if (!info.isFile() || !allowed.has(relative)) throw new Error(`Unexpected existing Web2API destination entry: ${relative}`);
  }
}

function launcher(command, argument = '') {
  return ['@echo off', 'setlocal DisableDelayedExpansion', '"%~dp0runtime\\node.exe" "%~dp0bridge\\cli.mjs" ' + command + (argument ? ` ${argument}` : '') + ' --data-dir "%~dp0.data"', 'set "GRAVITY_WEB2API_EXIT=%ERRORLEVEL%"', 'echo.', 'pause', 'exit /b %GRAVITY_WEB2API_EXIT%', ''].join('\r\n');
}

async function publishFile(destination, { source, content }) {
  await destinationAncestors(path.dirname(destination));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const existing = await statIfExists(destination);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error(`Web2API output must be a regular file: ${destination}`);
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}-${randomBytes(8).toString('hex')}.tmp`);
  try {
    if (source) await fs.copyFile(source, temporary, constants.COPYFILE_EXCL);
    else await fs.writeFile(temporary, content, { flag: 'wx' });
    await fs.rename(temporary, destination);
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Build a stable, extension-independent release sidecar. Existing .data is untouched. */
export async function packageWeb2Api({ sourceRoot = repoRoot, outputDir = path.join(repoRoot, 'release', 'Gravity-Web2API'), nodePath = process.execPath } = {}) {
  sourceRoot = path.resolve(sourceRoot); outputDir = path.resolve(outputDir); nodePath = path.resolve(nodePath);
  const bridge = path.join(sourceRoot, 'bridges', 'multi-web2api');
  if (inside(outputDir, bridge) || inside(bridge, outputDir) || inside(outputDir, path.dirname(nodePath))) throw new Error('Web2API destination must be separate from its source bridge and Node installation.');
  await validateBridgeEntries(bridge);
  const driver = path.join(bridge, 'node_modules', 'playwright-core');
  await regularDirectory(path.dirname(driver));
  await regularDirectory(driver);
  for (const filename of [path.join(bridge, 'package.json'), path.join(driver, 'package.json')]) {
    if ((await regularFile(filename)).size > 1024 * 1024) throw new Error('Web2API package metadata exceeds the supported size.');
  }
  const pkg = JSON.parse(await fs.readFile(path.join(bridge, 'package.json'), 'utf8'));
  const driverPkg = JSON.parse(await fs.readFile(path.join(driver, 'package.json'), 'utf8'));
  if (driverPkg.name !== 'playwright-core' || driverPkg.version !== pkg.dependencies?.['playwright-core'] || Object.keys(driverPkg.dependencies || {}).length) throw new Error('Install the exact pinned, dependency-free playwright-core package before packaging Web2API.');
  if (path.basename(nodePath).toLowerCase() !== 'node.exe') throw new Error('Web2API sidecar requires the installed Windows node.exe and its adjacent LICENSE.');
  const nodeLicense = path.join(path.dirname(nodePath), 'LICENSE');
  await regularFile(nodePath); await regularFile(nodeLicense);
  const inventory = [];
  for (const relative of bridgeFiles) { const source = path.join(bridge, relative); await regularFile(source); inventory.push({ source, relative: `bridge/${relative}` }); }
  const windowsReadme = path.join(bridge, 'WINDOWS.md'); await regularFile(windowsReadme);
  inventory.push({ source: windowsReadme, relative: 'README.md' }, { source: nodePath, relative: 'runtime/node.exe' }, { source: nodeLicense, relative: 'runtime/LICENSE' });
  const driverFiles = await driverInventory(driver);
  for (const required of ['package.json', 'LICENSE', 'NOTICE', 'ThirdPartyNotices.txt', 'index.js', 'index.mjs']) if (!driverFiles.some(file => file.relative === required)) throw new Error(`Browser-driver package is missing ${required}.`);
  inventory.push(...driverFiles.map(file => ({ ...file, relative: `bridge/node_modules/playwright-core/${file.relative}` })));
  for (const command of ['Setup', 'Start', 'Info', 'Models', 'Status']) inventory.push({ relative: `${command}.cmd`, content: launcher(command.toLowerCase()) });
  for (const [label, site] of [['DeepSeek', 'deepseek'], ['Qwen', 'qwen'], ['ChatGPT', 'chatgpt'], ['Zai', 'zai']]) inventory.push({ relative: `Login-${label}.cmd`, content: launcher('login', site) });
  const files = inventory.map(item => item.relative).sort();
  if (new Set(files.map(name => name.toLowerCase())).size !== files.length) throw new Error('Web2API package inputs have duplicate or case-colliding names.');
  await destinationAncestors(outputDir);
  await validateExistingDestination(outputDir, new Set(files));
  for (const item of inventory) await publishFile(path.join(outputDir, item.relative), item);
  return { outputDir, files };
}

if (process.argv[1] && normalize(process.argv[1]) === normalize(fileURLToPath(import.meta.url))) {
  packageWeb2Api().then(result => console.log(`Web2API sidecar: ${result.outputDir} (${result.files.length} files; private data preserved).`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
