// Build first, then run with Node. The portable app runs with no developer runtimes on PATH.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Store } from '../electron/store.mjs';
import { docxFixture, pdfFixture, pptxFixture, xlsxFixture } from './document-fixtures.mjs';

assert.equal(process.platform, 'win32', 'This smoke test checks the Windows portable executable.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = path.join(root, 'release');
const releaseDirectory = path.resolve(root, process.env.GRAVITY_RELEASE_DIR || 'release');
assert.ok(releaseDirectory === releaseRoot || releaseDirectory.startsWith(releaseRoot + path.sep), 'Portable smoke must use a workspace release directory');
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
const mainInspectorProbe = net.createServer();
await new Promise(resolve => mainInspectorProbe.listen(0, '127.0.0.1', resolve));
const mainInspectorPort = mainInspectorProbe.address().port;
await new Promise(resolve => mainInspectorProbe.close(resolve));
const websiteProbe = net.createServer();
await new Promise(resolve => websiteProbe.listen(0, '127.0.0.1', resolve));
const websitePort = websiteProbe.address().port;
await new Promise(resolve => websiteProbe.close(resolve));
const store = new Store(path.join(profile, 'state.json'));
// The fixed browser port may be occupied by the user's open app. Browser startup
// is exercised separately by electron-smoke with an isolated dynamic port.
store.updateSettings({ gatewayPort: port, browserAutoStart: false, uiScale: 125 });
const token = store.data.settings.gatewayToken;
let child, inspection, mainSocket, documentProvider;
const documentRequests = [];
const documentServer = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); documentRequests.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'portable-document-response', object: 'chat.completion.chunk', model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'PORTABLE_DOCUMENTS_OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } catch { res.writeHead(400); res.end(); }
});
await new Promise(resolve => documentServer.listen(0, '127.0.0.1', resolve));
try {
  await fs.mkdir(launchFolder);
  await fs.copyFile(path.join(releaseDirectory, path.basename(executable)), executable);
  const env = { ...process.env, GRAVITY_DATA_DIR: profile, PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'GRAVITY_DEV_URL', 'ANTIGRAVITY_DEV_URL', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GRAVITY_DEEPSEEK_TOKEN', 'GRAVITY_QWEN_TOKEN']) delete env[key];
  child = spawn(executable, [`--remote-debugging-port=${inspectorPort}`, `--inspect=${mainInspectorPort}`], { cwd: launchFolder, env, windowsHide: true, stdio: 'ignore' });
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
  // The inspector belongs only to this disposable executable. Stub the native
  // picker for authored fixtures; production exposes no arbitrary-path API.
  let mainTarget;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { mainTarget = (await (await fetch(`http://127.0.0.1:${mainInspectorPort}/json/list`, { signal: AbortSignal.timeout(700) })).json()).find(target => target.webSocketDebuggerUrl); if (mainTarget) break; } catch { /* Node inspector can initialize after the window. */ }
    await pause(100);
  }
  assert.ok(mainTarget, 'Packaged main-process inspector is available only for fixture setup');
  mainSocket = new WebSocket(mainTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { mainSocket.close(); reject(new Error('Packaged native fixture inspector did not connect.')); }, 10000);
    mainSocket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    mainSocket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Packaged native fixture inspector could not connect.')); }, { once: true });
  });
  let inspectorSequence = 0;
  const evaluateMain = expression => new Promise((resolve, reject) => {
    const id = ++inspectorSequence;
    const timer = setTimeout(() => settle(new Error('Packaged native fixture inspector timed out.')), 30000);
    const settle = (error, value) => { clearTimeout(timer); mainSocket.removeEventListener('message', receive); if (error) reject(error); else resolve(value); };
    const receive = event => {
      const response = JSON.parse(event.data); if (response.id !== id) return;
      if (response.error || response.result?.exceptionDetails) {
        const detail = response.error?.message || response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text;
        settle(new Error(`Packaged native fixture inspector rejected setup: ${detail}`)); return;
      }
      settle(null, response.result?.result?.value);
    };
    mainSocket.addEventListener('message', receive);
    mainSocket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  const documentFixtures = [
    ['portable.pdf', pdfFixture({ pages: 2, text: 'PORTABLE_PDF_MARKER' })],
    ['portable.docx', docxFixture('<w:p><w:r><w:t>PORTABLE_DOCX_MARKER</w:t></w:r></w:p>')],
    ['portable.xlsx', xlsxFixture({ 'xl/sharedStrings.xml': '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>PORTABLE_XLSX_MARKER</t></si></sst>' })],
    ['portable.pptx', pptxFixture({ 'ppt/slides/slide2.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>PORTABLE_PPTX_MARKER</a:t></a:r></a:p></p:sld>' })],
  ];
  const documentPaths = [];
  for (const [name, bytes] of documentFixtures) { const filename = path.join(temporary, name); await fs.writeFile(filename, bytes); documentPaths.push(filename); }
  // Inspector evaluations have no ESM referrer. Resolve Electron's built-in
  // module with Node's public createRequire instead of dynamic import.
  const fixtureElectron = "process.getBuiltinModule('module').createRequire(process.execPath)('electron')";
  await evaluateMain(`(() => { const {dialog} = ${fixtureElectron}; globalThis.__gravityFixtureDialog = dialog.showOpenDialog; dialog.showOpenDialog = async () => ({canceled:false,filePaths:${JSON.stringify(documentPaths)}}); return true; })()`);
  let selectedDocuments;
  try { selectedDocuments = await invoke('attachments:choose', { requestId: randomUUID() }); }
  finally { await evaluateMain(`(() => { const {dialog} = ${fixtureElectron}; dialog.showOpenDialog = globalThis.__gravityFixtureDialog; delete globalThis.__gravityFixtureDialog; return true; })()`); }
  assert.deepEqual(selectedDocuments.rejected, []);
  assert.deepEqual(selectedDocuments.files.map(file => file.format).sort(), ['docx', 'pdf', 'pptx', 'xlsx']);
  assert.equal(selectedDocuments.files.find(file => file.format === 'pdf').pages, 2);
  assert.equal(selectedDocuments.files.find(file => file.format === 'xlsx').sheets, 1);
  assert.equal(selectedDocuments.files.find(file => file.format === 'pptx').slides, 2);
  assert.ok(!JSON.stringify(selectedDocuments).includes(temporary), 'Document selections expose metadata and opaque IDs, not native paths');
  documentProvider = await invoke('provider:save', { name: 'Portable document fixture', type: 'openai', baseUrl: `http://127.0.0.1:${documentServer.address().port}/v1`, models: ['document-fixture'], defaultModel: 'document-fixture' });
  const documentChat = await invoke('conversation:create', { providerId: documentProvider.id, model: 'document-fixture', mode: 'chat', title: 'Packaged document smoke' });
  await invoke('conversation:send', { id: documentChat.id, content: 'Summarize the explicitly selected fixture documents.', fileIds: selectedDocuments.files.map(file => file.id) });
  let savedDocumentChat;
  for (let attempt = 0; attempt < 100; attempt++) { savedDocumentChat = (await invoke('state:get')).conversations.find(chat => chat.id === documentChat.id); if (savedDocumentChat?.status !== 'running') break; await pause(100); }
  assert.equal(savedDocumentChat?.status, 'idle', 'Packaged document context completes against a local fixture provider');
  assert.ok(savedDocumentChat.messages.some(message => message.role === 'assistant' && message.content.includes('PORTABLE_DOCUMENTS_OK')));
  const documentRequest = documentRequests.find(request => request.messages?.some(message => typeof message.content === 'string' && ['PORTABLE_PDF_MARKER', 'PORTABLE_DOCX_MARKER', 'PORTABLE_XLSX_MARKER', 'PORTABLE_PPTX_MARKER'].every(marker => message.content.includes(marker))));
  assert.ok(documentRequest, 'All four packaged document readers supply extracted text to the real agent boundary');
  assert.ok(!documentRequest.tools?.length, 'Standalone documents grant no project tools');
  assert.equal(savedDocumentChat.messages.find(message => message.role === 'user').files.length, 4);
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
  console.log('PASS: Packaged PDF, DOCX, XLSX and PPTX readers extract through the native picker and send read-only snapshots to a local fixture without developer runtimes or project tools.');
} finally {
  mainSocket?.close();
  await inspection?.close().catch(() => {});
  documentServer.closeAllConnections(); await new Promise(resolve => documentServer.close(resolve));
  if (child?.pid && child.exitCode === null) {
    await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
    await pause(500);
  }
  const resolved = path.resolve(temporary);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('gravity-portable-check-'));
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
