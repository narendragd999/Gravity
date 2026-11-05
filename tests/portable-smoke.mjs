// Build first, then run with Node. The portable app runs with no developer runtimes on PATH.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Store } from '../electron/store.mjs';

assert.equal(process.platform, 'win32', 'This smoke test checks the Windows portable executable.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gravity-portable-check-'));
const launchFolder = path.join(temporary, 'Folder with spaces');
const profile = path.join(temporary, 'isolated-profile');
const executable = path.join(launchFolder, `Gravity-${pkg.version}-x64.exe`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const inspectorProbe = net.createServer();
await new Promise(resolve => inspectorProbe.listen(0, '127.0.0.1', resolve));
const inspectorPort = inspectorProbe.address().port;
await new Promise(resolve => inspectorProbe.close(resolve));
const websiteProbe = net.createServer();
await new Promise(resolve => websiteProbe.listen(0, '127.0.0.1', resolve));
const websitePort = websiteProbe.address().port;
await new Promise(resolve => websiteProbe.close(resolve));
const store = new Store(path.join(profile, 'state.json'));
// The fixed browser port may be occupied by the user's open app. Browser startup
// is exercised separately by electron-smoke with an isolated dynamic port.
store.updateSettings({ gatewayPort: port, browserAutoStart: false, uiScale: 125 });
const token = store.data.settings.gatewayToken;
let child, inspection;
try {
  await fs.mkdir(launchFolder);
  await fs.copyFile(path.join(root, 'release', path.basename(executable)), executable);
  const env = { ...process.env, GRAVITY_DATA_DIR: profile, PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'GRAVITY_DEV_URL', 'ANTIGRAVITY_DEV_URL', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GRAVITY_DEEPSEEK_TOKEN', 'GRAVITY_QWEN_TOKEN']) delete env[key];
  child = spawn(executable, [`--remote-debugging-port=${inspectorPort}`], { cwd: launchFolder, env, windowsHide: true, stdio: 'ignore' });
  let launchError;
  child.once('error', error => { launchError = error; });
  const base = `http://127.0.0.1:${port}`;
  let health;
  for (let attempt = 0; attempt < 180; attempt++) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Portable launcher exited before startup (${child.exitCode}).`);
    try { health = await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(700) })).json(); if (health.status === 'ok') break; } catch { /* Self-extraction and initialization take time. */ }
    await pause(500);
  }
  assert.equal(health?.status, 'ok', 'Relocated executable starts its API without Node, Python, or Git on PATH');
  assert.equal(health.service, 'gravity');
  assert.equal((await fetch(`${base}/v1/models`)).status, 401, 'API still requires its generated key');
  const response = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).data.length > 0);
  const require = createRequire(new URL('../bridges/multi-web2api/package.json', import.meta.url));
  const { chromium } = require('playwright-core');
  inspection = await chromium.connectOverCDP(`http://127.0.0.1:${inspectorPort}`);
  const page = inspection.contexts().flatMap(context => context.pages()).find(item => item.url().startsWith('file:'));
  assert.ok(page, 'Packaged desktop page is available for fixture inspection');
  await page.waitForFunction(() => !!window.desktop);
  const invoke = (method, args = {}) => page.evaluate(({ method, args }) => window.desktop.invoke(method, args), { method, args });
  assert.equal((await invoke('web2api:refresh')).available, true, 'Standalone executable contains the website service without a companion folder');
  const websiteData = path.join(profile, 'web2api');
  await fs.mkdir(websiteData, { recursive: true });
  const websiteToken = 'portable-fixture-local-token-1234567890';
  // This is an advertised-model fixture only. Browser adapters open no website
  // at startup/discovery, and this check sends no generation request.
  await fs.writeFile(path.join(websiteData, 'config.json'), JSON.stringify({ port: websitePort, apiToken: websiteToken, browserChannel: 'chrome',
    providers: { deepseek: { enabled: false }, qwen: { enabled: false }, chatgpt: { enabled: false }, zai: { enabled: true } } }));
  const connected = await invoke('web2api:connect', { siteId: 'zai' });
  assert.equal(connected.phase, 'ready'); assert.equal(connected.defaultModel, 'zai-web');
  const websiteState = await invoke('state:get');
  assert.equal(websiteState.settings.bridgesAutoStart, true);
  const websiteProfile = websiteState.bridgeProfiles.find(item => item.id === connected.bridgeId);
  assert.equal(websiteProfile.launchMode, 'managed'); assert.equal(websiteProfile.args[3], websiteData);
  const driverLoad = await new Promise((resolve, reject) => execFile(websiteProfile.executable,
    ['--input-type=module', '-e', "const { chromium } = await import('./node_modules/playwright-core/index.mjs'); console.log(typeof chromium.launchPersistentContext);"],
    { cwd: websiteProfile.cwd, env, windowsHide: true, timeout: 10000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  assert.equal(driverLoad.trim(), 'function', 'Bundled Node can import its browser driver without installed dependencies');
  const websiteModels = await fetch(`http://127.0.0.1:${websitePort}/v1/models`, { headers: { Authorization: `Bearer ${websiteToken}` } });
  assert.equal(websiteModels.status, 200);
  assert.ok((await websiteModels.json()).data.some(item => item.id === 'zai-web'));
  assert.equal((await fetch(`http://127.0.0.1:${websitePort}/v1/models`)).status, 401);
  const saved = JSON.parse(await fs.readFile(path.join(profile, 'state.json'), 'utf8'));
  assert.equal(saved.settings.uiScale, 125);
  assert.equal(saved.settings.gatewayAutoStart, true);
  assert.equal(saved.settings.gatewayToken, token);
  assert.ok(!JSON.stringify(saved.providers).includes(websiteToken), 'In-app setup stores the local provider key with OS encryption');
  await invoke('bridges:stop', { id: connected.bridgeId });
  console.log('PASS: Gravity portable launches from a separate folder with spaces, without developer runtimes on PATH; API starts automatically and authentication and saved preferences work.');
  console.log('PASS: Bundled website service connects through the in-app setup without sidecar files, system Node, website traffic, or inference; keys are encrypted and managed startup is saved.');
} finally {
  await inspection?.close().catch(() => {});
  if (child?.pid && child.exitCode === null) {
    await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
    await pause(500);
  }
  const resolved = path.resolve(temporary);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('gravity-portable-check-'));
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
