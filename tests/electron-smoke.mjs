// Run through Electron, not node --test. Uses disposable data and a local fixture provider.
import { app, BrowserWindow, clipboard, dialog } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
async function runSmoke() {
const smokePackage = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
// Electron launched with a script reports its own version; exercise the same
// app version label that the packaged release reports.
app.getVersion = () => smokePackage.version;
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-desktop-smoke-'));
assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
process.env.ANTIGRAVITY_DATA_DIR = path.join(temporary, 'settings');
process.env.ANTIGRAVITY_TEST_CONNECTOR_PORT = '0';
process.env.GRAVITY_TEST_GATEWAY_PORT = '0';
for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete process.env[key];
delete process.env.ANTIGRAVITY_DEV_URL;
// The app setup flow uses a disposable local-only service, never a live
// website or the user's release companion configuration/browser profiles.
const websiteFixtureRoot = path.join(temporary, 'website-service');
const websiteFixtureBridge = path.join(websiteFixtureRoot, 'bridge');
const websiteFixtureCli = path.join(websiteFixtureBridge, 'cli.mjs');
const websiteFixtureData = path.join(websiteFixtureRoot, '.data');
const websiteFixtureRuntime = path.join(websiteFixtureRoot, 'runtime', 'node.exe');
const websiteFixtureKey = 'web2api-smoke-secret-never-render-123456789';
await fs.mkdir(path.dirname(websiteFixtureRuntime), { recursive: true });
await fs.mkdir(websiteFixtureBridge, { recursive: true });
await fs.mkdir(websiteFixtureData, { recursive: true });
await fs.copyFile(new URL('../release/Gravity-Web2API/runtime/node.exe', import.meta.url), websiteFixtureRuntime);
const websitePortProbe = http.createServer();
await new Promise(resolve => websitePortProbe.listen(0, '127.0.0.1', resolve));
const websiteFixturePort = websitePortProbe.address().port;
await new Promise(resolve => websitePortProbe.close(resolve));
await fs.writeFile(path.join(websiteFixtureData, 'config.json'), JSON.stringify({ port: websiteFixturePort, apiToken: websiteFixtureKey, browserChannel: 'chrome',
  providers: { chatgpt: { enabled: false }, zai: { enabled: true }, deepseek: { enabled: false }, qwen: { enabled: false } } }));
await fs.writeFile(websiteFixtureCli, `import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2), command = args[0];
const dataDir = path.resolve(args[args.indexOf('--data-dir') + 1]);
const config = JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8'));
const cli = fileURLToPath(import.meta.url), cwd = path.dirname(cli);
const baseUrl = 'http://127.0.0.1:' + config.port;
if (command === 'browsers' && args.includes('--json')) {
  console.log(JSON.stringify({ browserChannel: config.browserChannel, runtimeVersion: process.version,
    browsers: [{ channel: 'chrome', installed: true }, { channel: 'msedge', installed: true }] }));
} else if (command === 'browser') {
  config.browserChannel = args[1]; await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify(config));
} else if (command === 'info' && args.includes('--json')) {
  console.log(JSON.stringify({ provider: { name: 'Gravity Web2API', type: 'openai', baseUrl: baseUrl + '/v1', apiKey: config.apiToken },
    bridge: { name: 'Gravity Web2API', launchMode: 'managed', executable: process.execPath, args: [cli, 'start', '--data-dir', dataDir], cwd, healthUrl: baseUrl + '/health', startupTimeoutMs: 30000 } }));
} else if (command === 'start') {
  const server = http.createServer(async (req, res) => {
    await fs.appendFile(path.join(dataDir, 'requests.log'), req.method + ' ' + req.url + '\\n');
    res.setHeader('Content-Type', 'application/json');
    if (req.socket.remoteAddress !== '127.0.0.1') { res.writeHead(403); res.end('{}'); return; }
    if (req.method === 'GET' && req.url === '/health') { res.end(JSON.stringify({ ok: true })); return; }
    if (req.headers.authorization !== 'Bearer ' + config.apiToken) { res.writeHead(401); res.end(JSON.stringify({ error: { message: 'Fixture local key required' } })); return; }
    if (req.method === 'GET' && req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'zai-web', object: 'model' }] })); return; }
    res.writeHead(400); res.end(JSON.stringify({ error: { message: 'Fixture permits health and model checks only; inference is disabled' } }));
  });
  await new Promise(resolve => server.listen(config.port, '127.0.0.1', resolve));
  console.log('Disposable website fixture ready.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
} else { console.error('Unsupported fixture command'); process.exitCode = 1; }
`);
process.env.GRAVITY_TEST_WEB2API_ROOT = websiteFixtureRoot;
let desktopWindow;
const fixtureRequests = [];
const mock = http.createServer(async (req, res) => {
  fixtureRequests.push({ method: req.method, url: req.url });
  if (req.url === '/discovery-only/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'listed-but-unavailable' }] })); return; }
  if (req.url === '/discovery-only/v1/chat/completions') { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Fixture generation unavailable' } })); return; }
  if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'smoke-model' }] })); return; }
  let raw = ''; for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  fixtureRequests.at(-1).body = body;
  const last = body.messages?.at(-1);
  const reviewRequest = body.messages?.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('SMOKE_REVIEW_FILE'));
  let toolCall;
  if (reviewRequest && body.tools?.some(tool => tool.function.name === 'propose_file')) {
    if (last?.role === 'user') toolCall = { id: 'smoke-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'hello.txt' }) } };
    else if (last?.role === 'tool' && last.tool_call_id === 'smoke-read') toolCall = { id: 'smoke-write', type: 'function', function: { name: 'propose_file', arguments: JSON.stringify({ path: 'hello.txt', content: 'hello after agent edit\ncontext line two\n' }) } };
  }
  const message = toolCall ? { role: 'assistant', content: null, tool_calls: [toolCall] } : { role: 'assistant', content: 'Local fixture verified.' };
  const finishReason = toolCall ? 'tool_calls' : 'stop';
  const answer = { id: 'smoke-response', object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, message, finish_reason: finishReason }] };
  if (body.stream) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ ...answer, object: 'chat.completion.chunk', choices: [{ index: 0, delta: toolCall ? { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] } : message, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`); }
  else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(answer)); }
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanupWebsiteFixture = async () => {
  if (desktopWindow && !desktopWindow.isDestroyed()) {
    try {
      const saved = await desktopWindow.webContents.executeJavaScript(`window.desktop.invoke('state:get')`);
      for (const profile of saved.bridgeProfiles.filter(item => item.args?.[0] === websiteFixtureCli)) {
        await desktopWindow.webContents.executeJavaScript(`window.desktop.invoke('bridges:stop', ${JSON.stringify({ id: profile.id })})`);
      }
    } catch { /* The native window can already be closing after a failed test. */ }
  }
  assert.equal(path.dirname(path.resolve(websiteFixtureRoot)), path.resolve(temporary));
  assert.ok(path.basename(path.resolve(temporary)).startsWith('antigravity-desktop-smoke-'));
  // Windows can retain a just-stopped executable handle briefly.
  await fs.rm(websiteFixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
};
try {
  await import('../electron/main.mjs');
  await app.whenReady();
  let win;
  for (let i = 0; i < 300; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoadingMainFrame() && await win.webContents.executeJavaScript('!!window.desktop && !!document.querySelector(".welcome h1")').catch(() => false)) break;
    await pause(50);
  }
  assert.ok(win, 'Desktop creates a native window');
  desktopWindow = win;
  const text = await win.webContents.executeJavaScript('document.body.innerText');
  assert.match(text, /Start a conversation/); assert.doesNotMatch(text, /Interface preview|Untrusted desktop request/);
  const invoke = (method, args) => win.webContents.executeJavaScript(`window.desktop.invoke(${JSON.stringify(method)},${JSON.stringify(args ?? {})})`);
  const evaluate = script => win.webContents.executeJavaScript(script);
  const waitFor = async (script, message) => {
    for (let i = 0; i < 200; i++) { if (await evaluate(script)) return; await pause(50); }
    assert.fail(message);
  };
  const click = async selector => {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`, `Enabled control exists: ${selector}`);
    await evaluate(`(() => { for (let parent = document.querySelector(${JSON.stringify(selector)}).parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS' && !parent.open) parent.querySelector('summary').click(); })()`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  };
  const setValue = async (selector, value) => {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, `Form field exists: ${selector}`);
    await evaluate(`(() => { for (let parent = document.querySelector(${JSON.stringify(selector)}).parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS' && !parent.open) parent.querySelector('summary').click(); })()`);
    await evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value').set; setter.call(field, ${JSON.stringify(value)}); field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  };
  const permissionIs = label => `document.querySelector('[data-testid="permissions-trigger"]')?.getAttribute('aria-label') === ${JSON.stringify(`Action permissions: ${label}`)}`;
  await waitFor(`document.querySelector('[aria-label="Agent mode"]')?.value === 'chat' && !!document.querySelector('[data-testid="chat-mode-note"]')`, 'New conversations start in tool-free Chat mode');
  assert.equal(await evaluate(`!!document.querySelector('[data-testid="permissions-trigger"]')`), false, 'Chat mode does not show action permissions');
  await setValue('[aria-label="Agent mode"]', 'build');
  await waitFor(permissionIs('Ask for approval'), 'Build starts with Ask for approval');
  await waitFor(`window.desktop.invoke('state:get').then(s => s.gateway.running && s.browserConnector.running)`, 'API and browser connector start automatically');
  const state = await invoke('state:get'); assert.equal(state.settings.theme, 'light');
  assert.equal(state.settings.uiScale, 110); assert.equal(state.settings.gatewayAutoStart, true); assert.equal(state.settings.browserAutoStart, true);
  assert.equal(await evaluate('document.title'), 'Gravity');
  assert.ok(await evaluate(`parseFloat(getComputedStyle(document.querySelector('.composer textarea')).fontSize) >= 15`), 'Default composer text is comfortably readable');
  const output = path.resolve('artifacts'); await fs.mkdir(output, { recursive: true });
  win.webContents.setBackgroundThrottling(false); win.show(); win.focus(); await pause(300);
  await fs.writeFile(path.join(output, 'gravity-clean-welcome.png'), (await win.webContents.capturePage()).toPNG());
  win.setSize(980, 640); await invoke('settings:save', { uiScale: 125 }); await pause(300);
  await fs.writeFile(path.join(output, 'gravity-clean-small-window.png'), (await win.webContents.capturePage()).toPNG());
  await invoke('settings:save', { theme: 'dark' }); await pause(250);
  await fs.writeFile(path.join(output, 'gravity-clean-dark.png'), (await win.webContents.capturePage()).toPNG());
  await invoke('settings:save', { theme: 'light', uiScale: 110 }); win.setSize(1450, 960); await pause(250);
  await click('[data-testid="get-started"]');
  assert.equal(await evaluate(`document.querySelector('.settings-nav .selected').textContent`), 'Get started');
  assert.equal(await evaluate(`document.querySelectorAll('.setup-choice-grid > button').length`), 3, 'First setup separates Browser Connector, normal APIs and standalone Web2API');
  assert.match(await evaluate(`document.querySelector('.settings-nav').textContent`), /Browser Connector.*Models & providers.*Web2API Bridges.*API.*Appearance/);
  await pause(200); await fs.writeFile(path.join(output, 'gravity-get-started.png'), (await win.webContents.capturePage()).toPNG());
  await click('[data-testid="setup-web2api"]');
  assert.equal(await evaluate(`document.querySelector('.settings-nav .selected').textContent`), 'Web2API Bridges');
  for (const website of ['DeepSeek', 'Qwen', 'ChatGPT', 'Z.ai']) assert.ok((await evaluate(`document.querySelector('[data-testid="standalone-web2api-help"]').textContent`)).includes(website));
  await waitFor(`window.desktop.invoke('state:get').then(s => s.web2apiSetup.available && s.web2apiSetup.sites.find(site => site.id === 'zai').enabled)`, 'In-app setup detects only the disposable saved Z.ai fixture');
  assert.equal(await evaluate(`document.querySelector('[data-testid="web2api-site-zai"]').getAttribute('aria-pressed')`), 'true');
  assert.ok(await evaluate(`!!document.querySelector('[data-testid="web2api-sign-in-again"]')`), 'Saved sign-ins have an explicit recovery action');
  await click('[data-testid="web2api-connect"]');
  await waitFor(`window.desktop.invoke('state:get').then(s => s.web2apiSetup.phase === 'ready' && !s.web2apiSetup.busy)`, 'One click starts the fixture bridge and discovers its model');
  await waitFor(`!document.querySelector('[role="dialog"][aria-label="Settings"]')`, 'One-click website connection automatically selects the chat provider and closes settings');
  const websiteState = await invoke('state:get');
  const websiteProvider = websiteState.providers.find(item => item.id === websiteState.web2apiSetup.providerId);
  assert.equal(websiteProvider.baseUrl, `http://127.0.0.1:${websiteFixturePort}/v1`);
  assert.equal(websiteProvider.hasApiKey, true); assert.equal(websiteProvider.apiKey, undefined);
  assert.deepEqual(websiteProvider.models, ['zai-web']); assert.equal(websiteProvider.defaultModel, 'zai-web');
  const websiteProfile = websiteState.bridgeProfiles.find(item => item.id === websiteState.web2apiSetup.bridgeId);
  assert.equal(websiteProfile.launchMode, 'managed'); assert.equal(websiteProfile.providerId, websiteProvider.id);
  assert.equal(websiteProfile.executable, websiteFixtureRuntime);
  assert.deepEqual(websiteProfile.args, [websiteFixtureCli, 'start', '--data-dir', websiteFixtureData]);
  assert.equal(websiteState.bridges.find(item => item.id === websiteProfile.id).state, 'ready');
  assert.equal(websiteState.settings.bridgesAutoStart, true, 'One-click connection enables automatic future startup');
  assert.deepEqual(JSON.parse(await evaluate(`document.querySelector('.model-selector select').value`)), [websiteProvider.id, 'zai-web'], 'The composer uses the discovered website model automatically');
  assert.equal(websiteProvider.managedBy, 'web2api');
  await waitFor(`document.querySelector('.attachment-btn input')?.disabled && document.querySelector('[data-testid="chat-connection-status"]')?.textContent.includes('Text only')`, 'Website connections clearly disable image attachments');
  const imageConversation = await invoke('conversation:create', { providerId: websiteProvider.id, model: 'zai-web', mode: 'chat', title: 'Website image preflight' });
  await assert.rejects(invoke('conversation:send', { id: imageConversation.id, content: 'Image preflight', images: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'] }), /text only/i);
  assert.equal((await invoke('state:get')).conversations.find(item => item.id === imageConversation.id).messages.length, 0, 'Unsupported website images are rejected before creating a message');
  await evaluate(`(() => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array([137,80,78,71])], 'fixture.png', { type: 'image/png' })); document.querySelector('.composer textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })); })()`);
  await waitFor(`document.querySelector('.composer-error')?.textContent.includes('does not accept images')`, 'Pasting an image explains the website image limit');
  assert.equal(await evaluate(`document.querySelectorAll('.attachment-chip').length`), 0, 'Unsupported pasted images do not become hidden attachments');
  await click('[aria-label="Dismiss error"]');
  assert.ok(!JSON.stringify(websiteState).includes(websiteFixtureKey), 'The generated local key is never exposed in renderer state');
  assert.ok(!(await fs.readFile(path.join(temporary, 'settings', 'state.json'), 'utf8')).includes(websiteFixtureKey), 'The automatically imported provider key is encrypted');
  assert.doesNotMatch(await fs.readFile(path.join(websiteFixtureData, 'requests.log'), 'utf8'), /POST/, 'One-click setup sends no inference requests');
  await click('.sidebar-bottom .sidebar-nav');
  await click('[data-testid="bridges-tab"]');
  await waitFor(`!!document.querySelector('[data-testid="web2api-ready"]')`, 'Reopening Settings preserves website connection readiness');
  assert.equal(await evaluate(`document.querySelector('[data-testid="bridge-expert-settings"]').open`), false, 'Expert adapter forms stay collapsed by default');
  await click('.web2api-diagnostics > summary');
  await click('[data-testid="web2api-copy-diagnostics"]');
  await waitFor(`document.querySelector('.web2api-diagnostics')?.textContent.includes('Diagnostics copied')`, 'Safe diagnostics can be copied from the setup UI');
  const diagnostics = clipboard.readText();
  assert.equal(JSON.parse(diagnostics).version, 1);
  assert.doesNotMatch(diagnostics, /web2api-smoke-secret|Image preflight|requests\.log|Bearer|apiToken|settings\\state\.json/i);
  assert.ok(!diagnostics.includes(websiteFixtureRoot), 'Diagnostic output does not expose private filesystem paths');
  await click('.web2api-diagnostics > summary');
  await evaluate(`document.querySelector('[data-testid="web2api-setup"]').scrollIntoView({ block: 'start' })`); await pause(200);
  await fs.writeFile(path.join(output, 'gravity-web2api-one-click.png'), (await win.webContents.capturePage()).toPNG());
  const beforePreset = (await invoke('state:get')).providers;
  await click('[data-testid="settings-providers-tab"]');
  await click('[data-testid="provider-new"]');
  await click('[data-testid="provider-preset-web2api"]');
  assert.equal(await evaluate(`document.querySelector('[data-testid="provider-name"]').value`), 'Gravity Web2API');
  assert.equal(await evaluate(`document.querySelector('[data-testid="provider-base-url"]').value`), 'http://127.0.0.1:4320/v1');
  assert.equal(await evaluate(`document.querySelector('.settings-body input[type="password"]').value`), '');
  assert.equal(await evaluate(`document.querySelector('input[list="model-list"]').value`), '');
  assert.deepEqual((await invoke('state:get')).providers, beforePreset, 'Choosing the preset does not save credentials or settings');
  await click('[data-testid="settings-general-tab"]');
  await click('[data-testid="text-size-125"]');
  await waitFor(`document.querySelector('[data-testid="text-size-125"]').getAttribute('aria-pressed') === 'true'`, 'Text size saves immediately');
  assert.equal((await invoke('state:get')).settings.uiScale, 125);
  assert.ok(await evaluate(`parseFloat(getComputedStyle(document.querySelector('.composer textarea')).fontSize) >= 17`), 'Changing text size updates the workspace');
  win.setSize(980, 640); await pause(250);
  assert.ok(await evaluate(`(() => { const body = document.querySelector('.settings-body'); return body.scrollWidth <= body.clientWidth + 2; })()`), 'Large-text settings fit the minimum window width');
  await fs.writeFile(path.join(output, 'gravity-large-text.png'), (await win.webContents.capturePage()).toPNG());
  await click('[data-testid="text-size-110"]');
  await waitFor(`window.desktop.invoke('state:get').then(s => s.settings.uiScale === 110)`, 'Recommended text size restores');
  win.setSize(1450, 960); await pause(200);
  await click('[data-testid="settings-gateway-tab"]');
  assert.ok(await evaluate(`!document.querySelector('[data-testid="browser-setup"]')`), 'API settings are separate from Browser Connector');
  await pause(250);
  assert.equal(await evaluate(`document.querySelector('.settings-nav .selected').textContent`), 'API');
  await fs.writeFile(path.join(output, 'gravity-api.png'), (await win.webContents.capturePage()).toPNG());
  await click('[aria-label="Close settings"]');
  const provider = await invoke('provider:save', { name: 'Local smoke fixture', type: 'openai', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'smoke-secret-never-store-plain', models: ['smoke-model'], defaultModel: 'smoke-model' });
  assert.equal(provider.hasApiKey, true); assert.equal(provider.apiKey, undefined);
  const stored = await fs.readFile(path.join(temporary, 'settings/state.json'), 'utf8'); assert.ok(!stored.includes('smoke-secret-never-store-plain'));
  assert.equal((await invoke('provider:test', { id: provider.id, model: provider.defaultModel })).ok, true);
  assert.ok(fixtureRequests.some(r => r.method === 'POST' && r.url === '/v1/chat/completions'), 'Test model verifies a real generation request');
  const discoveryOnlyProvider = await invoke('provider:save', { name: 'Discovery-only fixture', type: 'openai', baseUrl: `http://127.0.0.1:${mock.address().port}/discovery-only/v1`, models: ['listed-but-unavailable'], defaultModel: 'listed-but-unavailable' });
  assert.deepEqual(await invoke('provider:models', { id: discoveryOnlyProvider.id }), ['listed-but-unavailable']);
  const discoveryOnlyTest = await invoke('provider:test', { id: discoveryOnlyProvider.id });
  assert.equal(discoveryOnlyTest.ok, false, 'Successful discovery cannot make failed generation pass');
  assert.match(discoveryOnlyTest.message, /Fixture generation unavailable/);
  await click('button.new-conversation');
  await setValue('.model-selector select', JSON.stringify([provider.id, provider.defaultModel]));
  const pickedPath = path.join(temporary, 'picked-note.md'); await fs.writeFile(pickedPath, 'SMOKE_PICKED_NOTE: only this explicitly selected file.');
  const originalDialog = dialog.showOpenDialog;
  let releasePicker;
  dialog.showOpenDialog = async () => new Promise(resolve => { releasePicker = resolve; });
  try {
    await click('[data-testid="attach-files"]');
    assert.equal(typeof releasePicker, 'function');
    await click('button.new-conversation');
    releasePicker({ canceled: false, filePaths: [pickedPath] });
    await waitFor(`!document.querySelector('[data-testid="attach-files"]').disabled`, 'Picker settles after its originating draft changes');
    assert.equal(await evaluate(`!!document.querySelector('[data-testid="picked-files"]')`), false, 'Late picker results never attach to a new draft');
  } finally { dialog.showOpenDialog = originalDialog; }
  dialog.showOpenDialog = async (_window, options) => { assert.equal(options.title, 'Attach files'); assert.ok(options.properties.includes('openFile') && options.properties.includes('multiSelections')); return { canceled: false, filePaths: [pickedPath] }; };
  try { await click('[data-testid="attach-files"]'); await waitFor(`document.querySelector('[data-testid="picked-files"]')?.textContent.includes('picked-note.md')`, 'Plus opens native file selection and shows the selected file without a project'); }
  finally { dialog.showOpenDialog = originalDialog; }
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  try {
    await click('[data-testid="attach-files"]');
    await waitFor(`!document.querySelector('[data-testid="attach-files"]').disabled`, 'Cancelled picker settles');
    assert.equal(await evaluate(`document.querySelector('[data-testid="picked-files"]')?.textContent.includes('picked-note.md')`), true, 'Cancellation retains existing attachments');
  } finally { dialog.showOpenDialog = originalDialog; }
  await fs.writeFile(path.join(output, 'gravity-file-attachment.png'), (await win.webContents.capturePage()).toPNG());
  await click('.send-btn[aria-label="Send message"]');
  await waitFor(`window.desktop.invoke('state:get').then(s => s.conversations.some(c => !c.projectId && c.status === 'idle' && c.messages.some(m => m.files?.some(f => f.name === 'picked-note.md'))))`, 'Selected file sends as projectless read-only chat context');
  assert.ok(fixtureRequests.some(request => request.body?.messages?.some(message => typeof message.content === 'string' && message.content.includes('SMOKE_PICKED_NOTE')) && !request.body.tools?.length), 'Picked text reaches the model with no workspace tools');
  const projectRoot = path.join(temporary, 'project'); await fs.mkdir(projectRoot);
  const originalFile = 'hello\ncontext line two\ncontext line three\n';
  await fs.writeFile(path.join(projectRoot, 'hello.txt'), originalFile);
  await fs.writeFile(path.join(projectRoot, 'AGENTS.md'), 'SMOKE_UNATTACHED_INSTRUCTION: This file must not enter tool-free Chat context.');
  await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'disposable-smoke-project', scripts: { dev: 'node never-run.cjs', test: 'node never-run.cjs' } }));
  await fs.writeFile(path.join(projectRoot, 'never-run.cjs'), "require('node:fs').writeFileSync('executed.txt', 'unexpected guide execution');");
  const project = await invoke('project:add', { path: projectRoot });
  assert.equal((await invoke('workspace:read', { projectId: project.id, path: 'hello.txt' })).content, originalFile);
  const staleContext = await invoke('workspace:context', { projectId: project.id, path: 'hello.txt', startLine: 2, endLine: 2 });
  const revisionConversation = await invoke('conversation:create', { projectId: project.id, providerId: provider.id, model: provider.defaultModel, mode: 'chat', title: 'Context revision preflight' });
  const beforeStaleContextRequests = fixtureRequests.length;
  await fs.writeFile(path.join(projectRoot, 'hello.txt'), originalFile.replace('context line two', 'changed saved line'));
  await assert.rejects(invoke('conversation:send', { id: revisionConversation.id, content: 'Stale saved context preflight', contexts: [{ projectId: project.id, path: staleContext.path, startLine: 2, endLine: 2, revision: staleContext.revision }] }), /changed|reattach|attach.*again/i);
  assert.equal(fixtureRequests.length, beforeStaleContextRequests, 'Changed context is rejected before contacting the provider');
  assert.equal((await invoke('state:get')).conversations.find(item => item.id === revisionConversation.id).messages.length, 0, 'Changed-context refusal does not append a chat message');
  await fs.writeFile(path.join(projectRoot, 'hello.txt'), originalFile);
  await click('button.new-conversation');
  await click('button.project-button');
  await setValue('.model-selector select', JSON.stringify([provider.id, provider.defaultModel]));
  await waitFor(`document.querySelector('[aria-label="Agent mode"]')?.value === 'chat'`, 'File discussion starts in tool-free Chat');
  await click('[title="Toggle workspace panel"]');
  await waitFor(`Array.from(document.querySelectorAll('.file-entry')).some(entry => entry.textContent === 'hello.txt')`, 'Project files are visible in the workspace');
  await evaluate(`Array.from(document.querySelectorAll('.file-entry')).find(entry => entry.textContent === 'hello.txt').click()`);
  await click('[data-testid="workspace-attach-file"]');
  await waitFor(`document.querySelector('[data-testid="composer-contexts"]')?.textContent.includes('hello.txt')`, 'Ask about file adds a visible saved-file context chip');
  await click('.composer-context-chip .icon-btn');
  await waitFor(`!document.querySelector('[data-testid="composer-contexts"]')`, 'File context can be removed before sending');
  await waitFor(`!!document.querySelector('.monaco-editor textarea')`, 'Local Monaco editor loads');
  await evaluate(`document.querySelector('.monaco-editor textarea').focus()`);
  for (const event of [{ keyCode: 'Home', modifiers: ['control'] }, { keyCode: 'Down' }, { keyCode: 'End', modifiers: ['shift'] }]) {
    win.webContents.sendInputEvent({ type: 'keyDown', ...event }); win.webContents.sendInputEvent({ type: 'keyUp', ...event });
  }
  await click('[data-testid="workspace-attach-selection"]');
  await waitFor(`document.querySelector('[data-testid="composer-contexts"]')?.textContent.includes('Lines 2–2')`, 'Selected line context shows its exact saved range');
  await setValue('.composer textarea', 'SMOKE_CONTEXT_CHAT explain the selected line');
  await waitFor(`document.querySelector('.composer textarea').value.includes('SMOKE_CONTEXT_CHAT') && !document.querySelector('.send-btn[aria-label="Send message"]').disabled`, 'Attached-context draft is ready to send');
  await fs.writeFile(path.join(output, 'gravity-chat-context.png'), (await win.webContents.capturePage()).toPNG());
  await click('.send-btn[aria-label="Send message"]');
  await waitFor(`window.desktop.invoke('state:get').then(s => s.conversations.some(c => c.mode === 'chat' && c.title.startsWith('SMOKE_CONTEXT_CHAT') && c.status === 'idle' && c.messages.some(m => m.role === 'assistant' && m.content === 'Local fixture verified.')))`, 'Chat completes through the local provider with only the selected file context');
  const contextConversation = (await invoke('state:get')).conversations.find(c => c.title.startsWith('SMOKE_CONTEXT_CHAT'));
  const contextRequest = fixtureRequests.findLast(request => request.body?.messages?.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('SMOKE_CONTEXT_CHAT'))).body;
  assert.ok(!contextRequest.tools?.length, 'Chat sends zero file, command or artifact tools');
  const selectedMessage = contextRequest.messages.findLast(message => message.role === 'user').content;
  assert.match(selectedMessage, /File: hello\.txt, lines 2-2\ncontext line two/);
  assert.doesNotMatch(selectedMessage, /context line three|SMOKE_UNATTACHED_INSTRUCTION/);
  assert.doesNotMatch(contextRequest.messages[0].content, /SMOKE_UNATTACHED_INSTRUCTION/);
  assert.equal(contextConversation.messages.find(message => message.role === 'user').contexts[0].content, 'context line two');
  assert.ok(Date.parse(contextConversation.request.receivedAt) >= Date.parse(contextConversation.request.startedAt));
  assert.ok(Date.parse(contextConversation.request.finishedAt) >= Date.parse(contextConversation.request.receivedAt));
  assert.ok(contextConversation.request.elapsedMs >= 0);
  await waitFor(`document.querySelector('[data-testid="request-progress"]')?.textContent.includes('Complete') && document.querySelector('[data-testid="request-progress"]')?.textContent.includes('First response')`, 'Request UI displays actual elapsed and first-response timing');
  await setValue('[aria-label="Agent mode"]', 'build');
  await waitFor(permissionIs('Ask for approval'), 'Switching file discussion to Build restores action approval');
  await setValue('.composer textarea', 'SMOKE_REVIEW_FILE update hello.txt for the disposable review test');
  await click('.send-btn[aria-label="Send message"]');
  await waitFor(`!!document.querySelector('.approval-card.pending')`, 'An actual model file proposal waits for review in Build');
  assert.equal(await fs.readFile(path.join(projectRoot, 'hello.txt'), 'utf8'), originalFile, 'The pending proposal has not changed the file');
  await click('.approval-card.pending .primary-btn');
  await waitFor(`window.desktop.invoke('state:get').then(s => s.conversations.find(c => c.id === ${JSON.stringify(contextConversation.id)})?.status === 'idle')`, 'Approved file change finishes');
  assert.equal(await fs.readFile(path.join(projectRoot, 'hello.txt'), 'utf8'), 'hello after agent edit\ncontext line two\n');
  await click('.approval-card.approved .secondary-btn');
  await waitFor(`!!document.querySelector('[data-testid="workspace-undo-edit"]') && !document.querySelector('[data-testid="workspace-undo-edit"]').disabled`, 'Changed-file action opens per-file agent review with Undo');
  assert.equal(await evaluate(`document.querySelector('[data-testid="workspace-review-input"]').value`), 'hello.txt');
  await waitFor(`Array.from(document.querySelectorAll('[data-testid="workspace-review-diff"] .view-line')).some(line => /hello.*after.*agent.*edit/.test(line.textContent))`, 'Read-only file diff renders the actual changed line');
  assert.ok(await evaluate(`document.querySelector('[data-testid="workspace-review-diff"]').getBoundingClientRect().height >= 220`), 'File review has a visible diff area');
  await pause(200);
  await fs.writeFile(path.join(output, 'gravity-file-review.png'), (await win.webContents.capturePage()).toPNG());
  await click('[data-testid="workspace-undo-edit"]');
  await waitFor(`window.desktop.invoke('workspace:read', { projectId: ${JSON.stringify(project.id)}, path: 'hello.txt' }).then(file => file.content === ${JSON.stringify(originalFile)})`, 'Undo restores the original file through the review UI');
  assert.equal(await fs.readFile(path.join(projectRoot, 'hello.txt'), 'utf8'), originalFile);
  await click('[data-testid="workspace-review-all"]');
  await click('.approval-card.approved .secondary-btn');
  await waitFor(`document.querySelector('[data-testid="workspace-review-input"]')?.value === 'hello.txt' && !!document.querySelector('[data-testid="workspace-undo-edit"]')`, 'The approval card reopens the same file after leaving its review');
  await click('[title="Open terminal"]');
  await waitFor(`!!document.querySelector('[data-testid="project-guide-use"]')`, 'Terminal shows the detected project run guide');
  const guide = await invoke('workspace:guide', { projectId: project.id });
  assert.ok(guide.detected.includes('Node.js')); assert.ok(guide.commands.some(item => item.command === 'npm run dev'));
  await pause(200); await fs.writeFile(path.join(output, 'gravity-project-guide.png'), (await win.webContents.capturePage()).toPNG());
  await click('[data-testid="project-guide-use"]');
  await waitFor(`!!document.querySelector('[aria-label="Shell command"]').value`, 'Guide fills the terminal command for review');
  const guidedCommand = await evaluate(`document.querySelector('[aria-label="Shell command"]').value`);
  assert.ok(guide.commands.some(item => item.command === guidedCommand), 'Guide uses an inspected project command');
  assert.equal(await fs.stat(path.join(projectRoot, 'executed.txt')).then(() => true, () => false), false, 'Selecting a guide command never starts a script');
  assert.equal(await evaluate(`document.querySelector('.terminal-output').textContent.includes('Process exited')`), false);
  await fs.writeFile(path.join(output, 'gravity-prepared-command.png'), (await win.webContents.capturePage()).toPNG());
  await click('[aria-label="Close workspace"]');
  const conversation = await invoke('conversation:create', { projectId: project.id, providerId: provider.id, model: 'smoke-model', mode: 'plan', title: 'Permission smoke conversation' });
  assert.equal(conversation.permissionMode, 'ask');
  await assert.rejects(invoke('conversation:update', { id: conversation.id, permissionMode: 'full' }), /Confirm full access/);
  assert.equal((await invoke('state:get')).conversations.find(c => c.id === conversation.id).permissionMode, 'ask');
  await invoke('conversation:send', { id: conversation.id, content: 'Run local fixture validation.' });
  let result;
  for (let i = 0; i < 100; i++) { result = (await invoke('state:get')).conversations.find(c => c.id === conversation.id); if (result.status !== 'running') break; await pause(30); }
  assert.equal(result.status, 'idle'); assert.ok(result.messages.some(m => m.content === 'Local fixture verified.'));
  const portProbe = http.createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const gatewayPort = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  await invoke('gateway:stop');
  await invoke('settings:save', { gatewayPort });
  const gateway = await invoke('gateway:start');
  const models = await fetch(`${gateway.url}/models`, { headers: { Authorization: `Bearer ${state.settings.gatewayToken}` } });
  assert.equal(models.status, 200); assert.ok((await models.json()).data.some(m => m.id === `${provider.id}/smoke-model`));
  await invoke('gateway:stop');
  await invoke('clipboard:write', { text: 'Gravity desktop smoke test passed' });

  // Exercise the actual renderer controls and IPC persistence in this disposable profile.
  await click('button.conversation-link[title="Permission smoke conversation"]');
  const legacyProvider = await invoke('provider:save', { name: 'Claude web2api stopped fixture', type: 'openai', baseUrl: `http://127.0.0.1:${gatewayPort}/v1/chat/completions`, models: ['claude-3-5-sonnet'], defaultModel: 'claude-3-5-sonnet' });
  await invoke('conversation:update', { id: conversation.id, providerId: legacyProvider.id, model: legacyProvider.defaultModel });
  await invoke('conversation:send', { id: conversation.id, content: 'Exercise a stopped local bridge.' });
  await waitFor(`window.desktop.invoke('state:get').then(s => s.conversations.find(c => c.id === ${JSON.stringify(conversation.id)})?.status === 'error')`, 'Stopped local bridge produces a conversation failure');
  const beforeSwitch = (await invoke('state:get')).conversations.find(c => c.id === conversation.id);
  assert.ok(beforeSwitch.messages.some(m => /Nothing is accepting connections/.test(m.content)), 'Failure identifies the stopped endpoint');
  await setValue('.composer textarea', 'Keep this draft during connection recovery.');
  await click('[data-testid="chat-change-provider"]');
  await waitFor(`document.querySelector('[data-testid="provider-name"]')?.value === ${JSON.stringify(legacyProvider.name)}`, 'Settings opens the provider used by the current conversation');
  assert.match(await evaluate(`document.querySelector('[data-testid="current-chat-provider"]').textContent`), /Claude web2api stopped fixture.*claude-3-5-sonnet/);
  await click(`[data-testid="provider-${discoveryOnlyProvider.id}"]`);
  await click('[data-testid="provider-test-model"]');
  await waitFor(`document.querySelector('.notice.error[role="status"]')?.textContent.includes('Fixture generation unavailable')`, 'Renderer reports generation failure after successful discovery');
  assert.equal((await invoke('state:get')).conversations.find(c => c.id === conversation.id).providerId, legacyProvider.id, 'Inspecting or testing another provider does not switch the conversation');
  await click(`[data-testid="provider-${provider.id}"]`);
  await click('[data-testid="provider-test-model"]');
  await waitFor(`!!document.querySelector('.notice.success[role="status"]') && !document.querySelector('[data-testid="provider-test-model"]').disabled`, 'A completed model response is reported as success');
  assert.equal((await invoke('state:get')).conversations.find(c => c.id === conversation.id).providerId, legacyProvider.id, 'Successful test keeps the existing chat provider until explicitly applied');
  await evaluate(`document.querySelector('.settings-body').scrollTop = 0`); await pause(200);
  await fs.writeFile(path.join(output, 'provider-connection.png'), (await win.webContents.capturePage()).toPNG());
  await evaluate(`document.querySelector('[data-testid="use-provider-in-chat"]').scrollIntoView({ block: 'center' })`); await pause(200);
  await fs.writeFile(path.join(output, 'provider-test-result.png'), (await win.webContents.capturePage()).toPNG());
  const beforeApplyRequests = fixtureRequests.length;
  await click('[data-testid="use-provider-in-chat"]');
  await waitFor(`!document.querySelector('[role="dialog"][aria-label="Settings"]')`, 'Applying the provider closes settings');
  const afterSwitch = (await invoke('state:get')).conversations.find(c => c.id === conversation.id);
  assert.equal(afterSwitch.providerId, provider.id); assert.equal(afterSwitch.model, provider.defaultModel);
  assert.equal(afterSwitch.status, 'idle', 'Switching provider clears failure state from the old endpoint');
  assert.deepEqual(afterSwitch.messages, beforeSwitch.messages, 'Changing provider preserves conversation history');
  assert.equal(afterSwitch.title, beforeSwitch.title); assert.equal(afterSwitch.projectId, beforeSwitch.projectId);
  assert.equal(await evaluate(`document.querySelector('.composer textarea').value`), 'Keep this draft during connection recovery.', 'Provider switching keeps the unsent recovery draft');
  assert.equal(fixtureRequests.length, beforeApplyRequests, 'Applying a connection never replays the failed prompt or sends the draft');
  await waitFor(`document.querySelector('[data-testid="chat-connection"]')?.textContent.includes(${JSON.stringify(provider.name)})`, 'Composer displays the selected provider after switching');
  assert.equal(await evaluate(`document.querySelector('[data-testid="chat-connection"]').classList.contains('needs-attention')`), false, 'New provider is not marked failed by the old request');
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.assistant-message')).find(m => m.textContent.includes('Nothing is accepting connections'))?.querySelector('.assistant-label strong')?.textContent`), 'Request failed', 'Historical error is not relabeled with the newly selected provider');
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.assistant-message .markdown')).some(m => !m.textContent.trim())`), false, 'Failed streams do not leave a blank response under the newly selected provider');
  await fs.writeFile(path.join(output, 'chat-connection.png'), (await win.webContents.capturePage()).toPNG());
  await evaluate(`document.querySelector('[data-testid="chat-connection-details"] > summary').click()`);
  await pause(200); await fs.writeFile(path.join(output, 'gravity-clean-connection-details.png'), (await win.webContents.capturePage()).toPNG());
  await evaluate(`document.querySelector('[data-testid="chat-connection-details"] > summary').click()`);
  await waitFor(permissionIs('Ask for approval'), 'Saved conversation renders its approval mode');
  await click('[data-testid="permissions-trigger"]');
  await waitFor(`document.querySelectorAll('#action-permissions-menu [role="menuitemradio"]').length === 3`, 'All three approval choices are visible');
  assert.match(await evaluate(`document.querySelector('#action-permissions-menu').textContent`), /Plan mode stays read-only/);
  await click('[data-testid="permission-full"]');
  await waitFor(`!!document.querySelector('[role="dialog"][aria-labelledby="full-access-title"]')`, 'Full access requires confirmation');
  assert.ok(await evaluate(permissionIs('Ask for approval')), 'Opening confirmation does not grant access');
  await click('[data-testid="full-access-cancel"]');
  await waitFor(`!document.querySelector('[data-testid="full-access-confirm"]')`, 'Cancel closes full access confirmation');
  assert.equal((await invoke('state:get')).conversations.find(c => c.id === conversation.id).permissionMode, 'ask');
  await click('[data-testid="permissions-trigger"]');
  await click('[data-testid="permission-auto-edits"]');
  await waitFor(permissionIs('Approve file edits'), 'File edit selection updates the UI');
  assert.equal((await invoke('state:get')).conversations.find(c => c.id === conversation.id).permissionMode, 'auto-edits');
  await click('[data-testid="permissions-trigger"]');
  await click('[data-testid="permission-full"]');
  await click('[data-testid="full-access-confirm"]');
  await waitFor(permissionIs('Full access'), 'Explicit confirmation enables full access');
  const confirmed = (await invoke('state:get')).conversations.find(c => c.id === conversation.id);
  assert.equal(confirmed.permissionMode, 'full');
  assert.equal(confirmed.mode, 'plan', 'Full access does not change Plan mode');
  assert.ok(confirmed.messages.some(m => m.toolName === 'permissions' && m.content.startsWith('Full access:')), 'Permission changes remain auditable');
  await click('button.new-conversation');
  await waitFor(`document.querySelector('[aria-label="Agent mode"]')?.value === 'chat' && !document.querySelector('[data-testid="permissions-trigger"]')`, 'A new chat resets to tool-free Chat');
  await setValue('[aria-label="Agent mode"]', 'build');
  await waitFor(permissionIs('Ask for approval'), 'Switching the new chat to Build resets approval mode');
  await click('[data-testid="permissions-trigger"]');
  await waitFor(`document.querySelector('[data-testid="permission-ask"]')?.getAttribute('aria-checked') === 'true'`, 'The default choice is checked');
  win.webContents.setBackgroundThrottling(false); win.show(); win.focus();
  await pause(1000);
  assert.doesNotMatch(await win.webContents.executeJavaScript('document.body.innerText'), /Opening your workspace/);
  const permissionsScreenshot = await win.webContents.capturePage(); await fs.writeFile(path.join(output, 'permissions-menu.png'), permissionsScreenshot.toPNG());
  await click('[data-testid="permissions-trigger"]');
  await pause(200);
  const screenshot = await win.webContents.capturePage(); await fs.writeFile(path.join(output, 'desktop-smoke.png'), screenshot.toPNG());
  await click('.sidebar-bottom .sidebar-nav');
  await click('[data-testid="bridges-tab"]');
  await click('[data-testid="bridge-expert-settings"] > summary');
  await click('[data-testid="bridge-profile-new"]');
  await setValue('#bridge-profile-name', 'Local fixture bridge');
  await setValue('#bridge-profile-provider', provider.id);
  await click('[data-testid="bridge-profile-save"]');
  await waitFor(`window.desktop.invoke('state:get').then(s => s.bridgeProfiles.some(p => p.name === 'Local fixture bridge'))`, 'Bridge profile is saved through the UI');
  const fixtureProfile = (await invoke('state:get')).bridgeProfiles.find(p => p.name === 'Local fixture bridge');
  assert.equal(fixtureProfile.launchMode, 'external');
  assert.equal((await invoke('state:get')).bridges.find(b => b.id === fixtureProfile.id).state, 'stopped', 'Save never starts a bridge');
  await click('[data-testid="bridge-profile-check"]');
  await waitFor(`window.desktop.invoke('state:get').then(s => s.bridges.some(b => b.id === ${JSON.stringify(fixtureProfile.id)} && b.state === 'ready'))`, 'External bridge is checked through the renderer');
  await waitFor(`!document.querySelector('[data-testid="bridge-profile-check"]').disabled`, 'Check completes');
  assert.ok(await evaluate(`document.querySelector('#bridge-profile-name').disabled`), 'Connected profiles cannot be edited');
  await click('[data-testid="bridge-profile-check"]');
  await waitFor(`!document.querySelector('[data-testid="bridge-profile-check"]').disabled`, 'Checking a connected bridge does not try to save locked settings');
  assert.doesNotMatch(await evaluate(`document.querySelector('[role="dialog"]').textContent`), /Stop or disconnect this bridge before editing/);
  await assert.rejects(invoke('provider:remove', { id: provider.id }), /linked bridge profiles/);
  await assert.rejects(invoke('bridges:save', { ...fixtureProfile, name: 'Unexpected edit' }), /Stop or disconnect/);
  const providerAfterDiscovery = await invoke('provider:save', { ...provider, models: ['smoke-model', 'custom-fixture'], defaultModel: 'smoke-model' });
  assert.ok(providerAfterDiscovery.models.includes('custom-fixture'), 'Models can be saved while a bridge is connected');
  await assert.rejects(invoke('provider:save', { ...provider, baseUrl: 'http://127.0.0.1:9999/v1' }), /Stop or disconnect/);
  await evaluate(`document.querySelector('.settings-body').scrollTop = 0`);
  await pause(250);
  const bridgeScreenshot = await win.webContents.capturePage(); await fs.writeFile(path.join(output, 'web2api-bridges.png'), bridgeScreenshot.toPNG());
  await click('[data-testid="bridge-profile-stop"]');
  await waitFor(`window.desktop.invoke('state:get').then(s => s.bridges.some(b => b.id === ${JSON.stringify(fixtureProfile.id)} && b.state === 'stopped'))`, 'External disconnect completes');
  assert.equal((await invoke('provider:test', { id: provider.id })).ok, true, 'Disconnect does not stop an external server');

  const slowScript = path.join(temporary, 'slow-start.cjs');
  await fs.writeFile(slowScript, 'setInterval(() => {}, 1000);');
  const slowProvider = await invoke('provider:save', { name: 'Startup cancellation fixture', type: 'openai', baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, models: ['fixture'], defaultModel: 'fixture' });
  await click('[data-testid="bridge-profile-new"]');
  await setValue('#bridge-profile-name', 'Managed cancellation fixture');
  await setValue('#bridge-profile-provider', slowProvider.id);
  await setValue('#bridge-profile-mode', 'managed');
  await setValue('#bridge-profile-executable', process.execPath);
  await setValue('#bridge-profile-args', JSON.stringify([slowScript]));
  await setValue('#bridge-profile-directory', temporary);
  await setValue('#bridge-profile-env', JSON.stringify({ ELECTRON_RUN_AS_NODE: '1', BRIDGE_TEST_SECRET: 'private-fixture-environment' }));
  await click('[data-testid="bridge-profile-start"]');
  await waitFor(`document.querySelector('[data-testid="bridge-profile-stop"]')?.textContent.includes('Cancel startup') && !document.querySelector('[data-testid="bridge-profile-stop"]').disabled`, 'Cancel startup is enabled while Start is pending');
  await click('[data-testid="bridge-profile-stop"]');
  await waitFor(`window.desktop.invoke('state:get').then(s => { const p = s.bridgeProfiles.find(p => p.name === 'Managed cancellation fixture'); return p && s.bridges.some(b => b.id === p.id && b.state === 'stopped' && !b.running && !b.starting); })`, 'Managed startup can be cancelled from the UI');
  const savedManaged = (await invoke('state:get')).bridgeProfiles.find(p => p.name === 'Managed cancellation fixture');
  assert.equal(savedManaged.env.BRIDGE_TEST_SECRET, '********');
  assert.ok(!(await fs.readFile(path.join(temporary, 'settings/state.json'), 'utf8')).includes('private-fixture-environment'), 'Bridge environment is encrypted at rest');
  await click('[data-testid="browser-connector-tab"]');
  if (!(await invoke('state:get')).browserConnector.running) await click('[data-testid="browser-start"]');
  await waitFor(`window.desktop.invoke('state:get').then(s => s.browserConnector.running && s.providers.some(p => p.managedBy === 'browser-connector'))`, 'Browser connector automatically configures its provider');
  const browserState = await invoke('state:get');
  const chromeProvider = browserState.providers.find(p => p.managedBy === 'browser-connector');
  assert.equal(chromeProvider.models.length, 6); assert.equal(chromeProvider.hasApiKey, true); assert.equal(chromeProvider.apiKey, undefined);
  assert.equal((await invoke('provider:models', { id: chromeProvider.id })).length, 6, 'Website routes can be listed before pairing');
  const unpairedTest = await invoke('provider:test', { id: chromeProvider.id, model: 'claude-web' });
  assert.equal(unpairedTest.ok, false, 'Six discoverable routes do not imply a paired browser');
  assert.match(unpairedTest.message, /pair|approve|extension/i);
  const shortcutConversation = await invoke('conversation:create', { projectId: project.id, providerId: legacyProvider.id, model: legacyProvider.defaultModel, mode: 'plan', title: 'Claude shortcut recovery' });
  await invoke('conversation:send', { id: shortcutConversation.id, content: 'Exercise Claude bridge recovery.' });
  await waitFor(`window.desktop.invoke('state:get').then(s => s.conversations.find(c => c.id === ${JSON.stringify(shortcutConversation.id)})?.status === 'error')`, 'Legacy Claude bridge fails before shortcut recovery');
  const beforeShortcut = (await invoke('state:get')).conversations.find(c => c.id === shortcutConversation.id);
  await click('[aria-label="Close settings"]');
  await click('button.conversation-link[title="Claude shortcut recovery"]');
  await click('[data-testid="use-chrome-claude"]');
  await waitFor(`window.desktop.invoke('state:get').then(s => { const c = s.conversations.find(c => c.id === ${JSON.stringify(shortcutConversation.id)}); return c?.providerId === ${JSON.stringify(chromeProvider.id)} && c.model === 'claude-web' && c.status === 'idle'; })`, 'Use Claude in Chrome selects the browser route and clears the old failure');
  const afterShortcut = (await invoke('state:get')).conversations.find(c => c.id === shortcutConversation.id);
  assert.deepEqual(afterShortcut.messages, beforeShortcut.messages, 'Claude shortcut preserves the existing conversation history');
  await waitFor(`document.querySelector('[data-testid="chat-connection"]')?.textContent.includes('Connect the Chrome extension and approve it')`, 'Recovered chat clearly reports the remaining browser pairing step');
  assert.equal(await evaluate(`!!document.querySelector('[data-testid="use-chrome-claude"]')`), false, 'Old bridge recovery action disappears after switching');
  await fs.writeFile(path.join(output, 'claude-recovery.png'), (await win.webContents.capturePage()).toPNG());
  await click('[data-testid="chat-connection"] .chat-connection-actions .text-btn');
  await waitFor(`!!document.querySelector('[data-testid="browser-setup"]')`, 'Recovered chat opens browser setup for pairing');
  const connectorBase = browserState.browserConnector.url.replace(/\/v1$/, '');
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop', pairingNonce = 'isolated-native-pairing-fixture-nonce-0123456789';
  const extensionRequest = (route, body, token) => fetch(connectorBase + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Connector-Extension-ID': extensionId, 'X-Connector-Protocol': '3', 'X-Connector-Version': '1.0.5', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const legacyPair = await fetch(connectorBase + '/connector/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Connector-Extension-ID': extensionId }, body: JSON.stringify({ extensionId, nonce: pairingNonce }) });
  assert.equal(legacyPair.status, 426, 'Old extension is rejected before pairing');
  await waitFor(`document.querySelector('[data-testid="browser-connector-error"]')?.textContent.includes('outdated')`, 'Upgrade instructions are visible for an older extension');
  const pendingPair = await extensionRequest('/connector/pair', { extensionId, nonce: pairingNonce }); assert.equal(pendingPair.status, 202);
  const pairing = await pendingPair.json();
  await waitFor(`document.querySelector('[data-testid="browser-extension-version"]')?.textContent.includes('1.0.5') && !document.querySelector('[data-testid="browser-connector-error"]')`, 'Compatible extension version replaces the stale-client error');
  assert.equal(await evaluate(`!!document.querySelector('[data-testid="browser-extension-version"]').closest('details')`), false, 'Active extension version stays visible when setup details are collapsed');
  const beforeApproval = await extensionRequest('/connector/pair/status', { id: pairing.id, nonce: pairingNonce }); assert.equal(beforeApproval.status, 202);
  await click(`[data-testid="browser-approve-${pairing.id}"]`);
  const afterApproval = await extensionRequest('/connector/pair/status', { id: pairing.id, nonce: pairingNonce }); assert.equal(afterApproval.status, 200);
  const extensionToken = (await afterApproval.json()).token;
  const missingTabTest = await invoke('provider:test', { id: chromeProvider.id, model: 'claude-web' });
  assert.equal(missingTabTest.ok, false, 'Pairing alone does not imply the selected website is ready');
  assert.match(missingTabTest.message, /Claude.*tab|tab.*Claude|open.*Claude/i);
  assert.equal((await extensionRequest('/connector/heartbeat', { sites: chromeProvider.models.map(model => ({ id: model.replace(/-web$/, ''), connected: true, busy: false })) }, extensionToken)).status, 200);
  await waitFor(`window.desktop.invoke('state:get').then(s => s.browserConnector.paired && s.browserConnector.sites.filter(s => s.connected).length === 6)`, 'All six site cards receive status without reading account data');
  await click('[data-testid="browser-test-qwen"]');
  let siteTestJob;
  for (let i = 0; i < 100; i++) { siteTestJob = (await (await extensionRequest('/connector/jobs', undefined, extensionToken)).json()).job; if (siteTestJob) break; await pause(50); }
  assert.equal(siteTestJob?.siteId, 'qwen', 'Site-card test uses Qwen instead of the provider default Claude');
  assert.deepEqual(siteTestJob.messages, [{ role: 'user', content: 'Reply with only OK.' }]);
  assert.equal(siteTestJob.tools, undefined, 'Website test sends no project context or application tools');
  assert.equal((await extensionRequest('/connector/results', { id: siteTestJob.id, siteId: 'qwen', rawText: 'OK' }, extensionToken)).status, 200);
  await waitFor(`document.querySelector('[data-testid="browser-test-result-qwen"]')?.textContent.includes('Response verified.') && document.querySelector('[data-testid="browser-test-result-qwen"]')?.textContent.includes('Checked ')`, 'Completed Qwen response shows its actual check time in its own site card');
  const checkedQwen = (await invoke('state:get')).providers.find(item => item.id === chromeProvider.id).lastTest;
  assert.equal(checkedQwen.model, 'qwen-web'); assert.ok(Number.isFinite(Date.parse(checkedQwen.checkedAt))); assert.ok(checkedQwen.durationMs >= 0);
  assert.equal((await invoke('state:get')).providers.find(p => p.id === chromeProvider.id).defaultModel, chromeProvider.defaultModel, 'Site test preserves the default model');
  const browserConversation = await invoke('conversation:create', { providerId: chromeProvider.id, model: 'claude-web', mode: 'plan', title: 'Browser connector fixture' });
  await invoke('conversation:send', { id: browserConversation.id, content: 'hello' });
  let browserJob;
  for (let i = 0; i < 100; i++) { browserJob = (await (await extensionRequest('/connector/jobs', undefined, extensionToken)).json()).job; if (browserJob) break; await pause(50); }
  assert.equal(browserJob?.siteId, 'claude');
  assert.ok(browserJob.messages.some(m => m.content === 'hello'));
  assert.ok(browserJob.tools.length, 'Greeting uses the same tool-enabled agent path as the reported failure');
  assert.equal((await extensionRequest('/connector/results', { id: browserJob.id, siteId: 'claude', rawText: '{“content”:“Hello! I’m Gravity, a coding agent working in your selected project folder.”,“tool_calls”:[]}' }, extensionToken)).status, 200);
  await waitFor(`window.desktop.invoke('state:get').then(s => s.conversations.some(c => c.id === ${JSON.stringify(browserConversation.id)} && c.status === 'idle' && c.messages.some(m => m.content === 'Hello! I’m Gravity, a coding agent working in your selected project folder.')))`, 'Desktop agent accepts the smart-quoted greeting without an action or error');
  assert.ok(!JSON.stringify(await invoke('state:get')).includes(extensionToken), 'Extension token never appears in public state');
  await evaluate(`document.querySelector('.settings-body').scrollTop = 0`); await pause(200);
  const browserScreenshot = await win.webContents.capturePage(); await fs.writeFile(path.join(output, 'browser-setup.png'), browserScreenshot.toPNG());
  await evaluate(`document.querySelector('.browser-sites').scrollIntoView({ block: 'center' })`); await pause(200);
  const browserSitesScreenshot = await win.webContents.capturePage(); await fs.writeFile(path.join(output, 'browser-sites.png'), browserSitesScreenshot.toPNG());
  await click('[data-testid="browser-revoke"]');
  await waitFor(`!document.querySelector('[data-testid="browser-test-result-qwen"]')`, 'Revoking pairing clears prior site-test results');
  assert.equal((await extensionRequest('/connector/jobs', undefined, extensionToken)).status, 403, 'Revoked extension identity is no longer paired');
  await click('[data-testid="browser-stop"]');
  assert.equal((await invoke('provider:test', { id: chromeProvider.id, model: 'claude-web' })).ok, false, 'A stopped connector cannot pass a model test');
  assert.doesNotMatch(await fs.readFile(path.join(websiteFixtureData, 'requests.log'), 'utf8'), /POST/, 'The in-app website fixture received health/model checks only');
  console.log('PASS: native rendering/IPC, default tool-free Chat, saved-line context chips and zero-tool requests, actual request timing, website image preflight and safe diagnostics, agent proposal/apply/per-file review/Undo, passive project guide, one-click website setup and automatic startup, encrypted credentials, actual timestamped response tests, provider switching with history preserved, Claude recovery, permission controls, adapter UI, extension pairing, six website statuses and revocation.');
  console.log(`Screenshots: ${path.join(output, 'gravity-chat-context.png')}, ${path.join(output, 'gravity-file-review.png')}, ${path.join(output, 'gravity-project-guide.png')}, ${path.join(output, 'gravity-prepared-command.png')}, ${path.join(output, 'gravity-web2api-one-click.png')}, ${path.join(output, 'desktop-smoke.png')}, ${path.join(output, 'permissions-menu.png')}, ${path.join(output, 'provider-connection.png')}, ${path.join(output, 'chat-connection.png')}, ${path.join(output, 'claude-recovery.png')}, ${path.join(output, 'web2api-bridges.png')}, ${path.join(output, 'browser-setup.png')}, ${path.join(output, 'browser-sites.png')}`);
  await cleanupWebsiteFixture();
  mock.closeAllConnections(); mock.close(); app.quit();
} catch (error) { console.error(error); await cleanupWebsiteFixture().catch(cleanupError => console.error(cleanupError)); mock.closeAllConnections(); mock.close(); app.exit(1); }
}
runSmoke().catch(error => { console.error(error); app.exit(1); });
