import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { setTimeout as pause } from 'node:timers/promises';
import { defaultDataDir, loadConfig, updateConfig, validateConfig } from './config.mjs';
import { createWebApiServer } from './server.mjs';
import { createDeepSeekAdapter } from './adapters/deepseek.mjs';
import { createQwenAdapter } from './adapters/qwen.mjs';
import { browserSites, createBrowserAdapter, openProfile, visibleChallenge, waitForSecurityCheck } from './adapters/browser.mjs';
import { openManualLogin, discoverInstalledBrowsers } from './manual-login.mjs';
import { LOGIN_ERRORS, loginFailure, makeLoginReporter } from './login-events.mjs';

export async function discoverAccountModels(adapters, signal) {
  signal?.throwIfAborted();
  const available = await waitForInputOrAbort(Promise.all(adapters.map(async adapter => {
    try { await adapter.discoverModels?.({ signal }); return true; }
    catch { signal?.throwIfAborted(); return false; }
  })), signal);
  signal?.throwIfAborted();
  // An expired account must not prevent other configured accounts from loading.
  // Retain no upstream error text, which can contain session credentials.
  adapters.forEach((adapter, index) => { adapter.available = available[index]; });
  if (!available.some(Boolean)) throw new Error('All configured website providers are unavailable. Sign in again or check the connection, then restart the bridge.');
  return adapters;
}

export function gravityPreset(config, dataDir) {
  const cwd = path.dirname(fileURLToPath(import.meta.url));
  return {
    provider: { name: 'Gravity Web2API', type: 'openai', baseUrl: `http://127.0.0.1:${config.port}/v1`, apiKey: config.apiToken },
    bridge: { name: 'Gravity Web2API', launchMode: 'managed', executable: process.execPath,
      args: [path.join(cwd, 'cli.mjs'), 'start', '--data-dir', path.resolve(dataDir)], cwd,
      healthUrl: `http://127.0.0.1:${config.port}/health`, startupTimeoutMs: 30000 },
  };
}

// Track pending header reads so Enter cannot race capture. Later requests take
// precedence even when their asynchronous header reads finish out of order.
export function createLoginTokenCapture(siteId) {
  let token, sequence = 0, acceptedSequence = 0;
  const pending = new Set();
  const capture = request => {
    if (!['deepseek', 'qwen'].includes(siteId)) return;
    let url;
    try { url = new URL(request.url()); } catch { return; }
    if (url.origin !== new URL(browserSites[siteId].url).origin || !url.pathname.startsWith('/api/')) return;
    const order = ++sequence;
    const operation = (async () => {
      let headers;
      try { headers = await request.allHeaders(); } catch { return; }
      if (!headers || typeof headers.authorization !== 'string') return;
      const match = /^Bearer ([^\s]+)$/i.exec(headers.authorization || '');
      if (match && match[1].length >= 16 && match[1].length <= 16384 && !/[;\x00-\x1f\x7f]/.test(match[1]) && order >= acceptedSequence) {
        token = match[1]; acceptedSequence = order;
      }
    })();
    pending.add(operation);
    operation.then(() => pending.delete(operation), () => pending.delete(operation));
  };
  return { capture, get token() { return token; }, async settle() {
    let timer;
    try { await Promise.race([Promise.allSettled([...pending]), new Promise(resolve => { timer = setTimeout(resolve, 3000); })]); }
    finally { clearTimeout(timer); }
  } };
}

async function localJson(response) {
  if (!response.body) throw new Error('The local bridge returned no response.');
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error('Response limit exceeded.');
      chunks.push(chunk);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { throw new Error('The local bridge returned invalid or oversized JSON.'); }
}

export function buildAdapters(config, dataDir) {
  const adapters = [];
  for (const [id, factory] of [['deepseek', createDeepSeekAdapter], ['qwen', createQwenAdapter]]) {
    const provider = config.providers[id];
    if (provider?.enabled && !provider.token) throw new Error(`${id} needs a website token in config or GRAVITY_${id.toUpperCase()}_TOKEN. Browser login is optional.`);
    if (provider?.enabled) adapters.push(factory({ token: provider.token, upstreamModel: provider.upstreamModel }));
  }
  for (const siteId of ['chatgpt', 'zai']) if (config.providers[siteId]?.enabled) {
    adapters.push(createBrowserAdapter({ siteId, dataDir, channel: config.providers[siteId].browserChannel || config.browserChannel }));
  }
  return adapters;
}

function waitForInputOrAbort(operation, signal) {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

// Google sign-in needs a normal browser during the human login step. Reopen
// only this bridge's profile afterwards to check readiness without submitting.
export async function loginBrowserProfile(siteId, config, dataDir, {
  openBrowser = openManualLogin, openContext = openProfile,
  createInput = () => createInterface({ input: stdin, output: stdout }),
  log = console.log, closeTimeoutMs = 15000, autoContinue = false, signal, loginTimeoutMs = 900000,
  securityCheckTimeoutMs = 120000, now = Date.now, wait = pause,
  browserChannel, report = () => {}, createDirectAdapter = (id, token) => (id === 'qwen' ? createQwenAdapter : createDeepSeekAdapter)({ token }),
} = {}) {
  const site = browserSites[siteId];
  if (!site) throw new Error('Choose chatgpt, zai, qwen, or deepseek for account setup.');
  const channel = browserChannel || config.providers[siteId]?.browserChannel || config.browserChannel;
  if (!['chrome', 'msedge'].includes(channel)) throw new Error('Choose Chrome or Edge.');
  let context, input, closeTimer, stage = 'opening-browser', securityUntil, securityNotified = false;
  const progress = next => { stage = next; report(next); };
  const collector = createLoginTokenCapture(siteId);
  const abortContext = () => { if (context) void context.close().catch(() => {}); };
  signal?.addEventListener('abort', abortContext, { once: true });
  try {
    signal?.throwIfAborted(); progress('opening-browser');
    const browser = await openBrowser({ siteId, dataDir, channel });
    input = autoContinue ? null : createInput();
    log(`Sign in to ${site.label} in the browser that just opened. Complete any required security checks yourself.`);
    log('Choose your website model, open a new empty chat, then close all windows of this separate browser.');
    log('Your usual browser profile is not read or changed. No test prompt is sent during login.');
    progress('waiting-for-sign-in');
    if (input) await waitForInputOrAbort(input.question('After signing in and closing that browser, press Enter here: '), signal);
    progress('waiting-for-browser-close');
    await waitForInputOrAbort(Promise.race([browser.waitForClose, new Promise((_, reject) => {
      closeTimer = setTimeout(() => reject(loginFailure('browser_close_timeout', stage, siteId)), autoContinue ? loginTimeoutMs : closeTimeoutMs);
    })]), signal);
    clearTimeout(closeTimer); progress('releasing-profile');
    log('Checking your saved sign-in in the separate browser. Keep this check window open if the website asks for verification; complete it yourself there.');
    progress('opening-profile');
    context = await openContext({ siteId, dataDir, channel, ...(browser.executable ? { executablePath: browser.executable } : {}) });
    signal?.throwIfAborted();
    const browserVersion = context.browser?.()?.version?.();
    if (/^\d+(?:\.\d+){1,4}$/.test(browserVersion || '')) report(stage, 'progress', undefined, { browserVersion });
    context.on?.('request', collector.capture);
    const page = context.pages()[0] || await context.newPage();
    progress('navigating');
    try { await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
    catch { signal?.throwIfAborted(); throw loginFailure('navigation_failed', stage, siteId); }
    progress('checking-session');
    const classifyPage = async () => {
      const classifyLocation = () => {
        if (page.isClosed?.()) return 'browser_closed_abnormally';
        let location; try { location = new URL(page.url()); } catch { return 'navigation_failed'; }
        if (location.hostname === 'accounts.google.com' && /rejected/.test(location.pathname)) return 'oauth_rejected';
        if (location.origin !== new URL(site.url).origin || /\/(?:auth|login|signin)(?:\/|$)/i.test(location.pathname)) return 'sign_in_required';
        return null;
      };
      let failure = classifyLocation(); if (failure) return failure;
      if (await visibleChallenge(page)) {
        securityUntil ??= now() + securityCheckTimeoutMs;
        progress('waiting-for-security-check');
        if (!securityNotified) { securityNotified = true; log('Complete the website security check yourself in the open verification browser. Gravity waits on this page without reopening or reloading it.'); }
        try { await waitForSecurityCheck(page, { signal, timeoutMs: Math.max(0, securityUntil - now()), now, wait }); }
        catch (error) { signal?.throwIfAborted(); throw loginFailure(error.code === 'browser_closed_abnormally' ? error.code : 'security_check_required', stage, siteId); }
        progress('checking-session');
        failure = classifyLocation(); if (failure) return failure;
      }
      return null;
    };
    let pageFailure = await classifyPage();
    if (pageFailure) throw loginFailure(pageFailure, stage, siteId);
    let token;
    if (['deepseek', 'qwen'].includes(siteId)) {
      await collector.settle(); token = collector.token;
      if (!token) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await pause(1500); signal?.throwIfAborted(); await collector.settle(); token = collector.token;
      }
      pageFailure = await classifyPage();
      if (pageFailure) throw loginFailure(pageFailure, stage, siteId);
      if (!token && siteId === 'qwen') token = (await context.cookies(site.url)).find(cookie => cookie.name === 'token')?.value;
      if (!token) throw loginFailure('session_missing', stage, siteId);
      try { await createDirectAdapter(siteId, token).checkAuth({ signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) }); }
      catch (error) { signal?.throwIfAborted(); throw loginFailure([401, 403].includes(error?.status) ? 'auth_expired' : 'session_invalid', stage, siteId); }
    } else {
      let composer;
      const readyUntil = Date.now() + 30000;
      while (!composer && Date.now() < readyUntil) {
        signal?.throwIfAborted();
        pageFailure = await classifyPage();
        if (pageFailure) throw loginFailure(pageFailure, stage, siteId);
        for (const selector of site.composer) {
          const candidate = page.locator(selector).first();
          if (await candidate.isVisible().catch(() => false) && await candidate.isEnabled().catch(() => false)) { composer = candidate; break; }
        }
        if (!composer) await pause(250);
      }
      if (!composer) throw loginFailure('composer_unavailable', stage, siteId);
      const location = new URL(page.url());
      if (!['', '/'].includes(location.pathname) || await page.locator(site.history).count()) throw loginFailure('new_chat_required', stage, siteId);
      const draft = await composer.evaluate(element => ('value' in element ? element.value : element.textContent) || '');
      if (draft.trim()) throw loginFailure('draft_present', stage, siteId);
    }
    context.off?.('request', collector.capture);
    await context.close(); context = null;
    signal?.throwIfAborted();
    progress('saving-session');
    await updateConfig(dataDir, current => { signal?.throwIfAborted(); current.providers[siteId] = { ...current.providers[siteId], enabled: true, browserChannel: channel, ...(token ? { token } : {}) }; });
    stage = 'complete'; report(stage, 'complete');
    log(`${site.label} setup saved. Double-click Start.cmd, then use Info.cmd to connect Gravity.`);
  } catch (error) {
    const code = signal?.aborted ? 'setup_cancelled' : Object.hasOwn(LOGIN_ERRORS, error?.code || '') ? error.code
      : stage === 'saving-session' ? 'setup_save_failed' : stage === 'opening-browser' ? 'browser_launch_failed' : 'verification_failed';
    const failure = loginFailure(code, error?.stage || stage, siteId);
    report(failure.stage, 'error', failure.code);
    throw failure;
  } finally {
    clearTimeout(closeTimer); input?.close(); signal?.removeEventListener('abort', abortContext);
    if (context) { context.off?.('request', collector.capture); await context.close().catch(() => {}); }
  }
}

export async function login(siteId, config, dataDir, { appMode = false, signal, browserChannel, createInput = () => createInterface({ input: stdin, output: stdout }) } = {}) {
  const site = browserSites[siteId];
  if (!site) throw new Error('Choose deepseek, qwen, chatgpt, or zai.');
  if (!appMode && !stdin.isTTY) throw new Error('Login needs an interactive terminal so you can complete sign-in yourself.');
  signal?.throwIfAborted();
  if (process.platform === 'win32') return loginBrowserProfile(siteId, config, dataDir, { autoContinue: appMode, signal, createInput, browserChannel,
    report: makeLoginReporter(siteId, { browserChannel: browserChannel || config.providers[siteId]?.browserChannel || config.browserChannel }) });
  const channel = browserChannel || config.providers[siteId]?.browserChannel || config.browserChannel;
  const context = await openProfile({ siteId, dataDir, channel });
  const collector = createLoginTokenCapture(siteId);
  context.on('request', collector.capture);
  const input = createInput();
  const abortContext = () => { void context.close().catch(() => {}); };
  signal?.addEventListener('abort', abortContext, { once: true });
  try {
    signal?.throwIfAborted();
    const page = context.pages()[0] || await context.newPage();
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    console.log(`Set up ${site.label} in this separate bridge profile. Complete any required sign-in/security checks yourself, then open a fresh chat.`);
    console.log('Your usual browser profile is not read or changed. No test prompt is sent during login.');
    await waitForInputOrAbort(input.question('Press Enter here when you have finished signing in: '), signal);
    signal?.throwIfAborted();
    if (new URL(page.url()).origin !== new URL(site.url).origin) throw new Error('The browser is still outside the selected website. Finish sign-in and try again.');
    await collector.settle();
    let token = collector.token;
    if (['deepseek', 'qwen'].includes(siteId)) {
      if (!token) { await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); await pause(1500); await collector.settle(); token = collector.token; }
      if (!token && siteId === 'qwen') token = (await context.cookies(site.url)).find(cookie => cookie.name === 'token')?.value;
      if (!token) throw new Error('No signed-in session token was observed. Finish sign-in, open a new chat, and run login again.');
      const factory = siteId === 'deepseek' ? createDeepSeekAdapter : createQwenAdapter;
      await factory({ token }).checkAuth({ signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
    }
    signal?.throwIfAborted();
    await updateConfig(dataDir, current => { current.providers[siteId] = { ...current.providers[siteId], enabled: true, browserChannel: channel, ...(token ? { token } : {}) }; });
    console.log(`${site.label} setup saved. Run npm start. Verify generation separately with npm run probe -- <model-id>.`);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error?.status) throw error;
    throw new Error(`${site.label} setup did not finish. Reopen its dedicated bridge profile and complete setup manually.`);
  } finally { input.close(); signal?.removeEventListener('abort', abortContext); context.off('request', collector.capture); await context.close().catch(() => {}); }
}

export async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const browserIndex = args.indexOf('--browser');
  let browserChannel;
  if (browserIndex >= 0) {
    browserChannel = args[browserIndex + 1];
    if (!['chrome', 'msedge'].includes(browserChannel)) throw new Error('Choose chrome or msedge for --browser.');
    args.splice(browserIndex, 2);
  }
  const appIndex = args.indexOf('--app');
  const appMode = appIndex >= 0;
  if (appMode) args.splice(appIndex, 1);
  const dataIndex = args.indexOf('--data-dir');
  let dataDir = defaultDataDir;
  if (dataIndex >= 0) {
    if (!args[dataIndex + 1] || args[dataIndex + 1].startsWith('--')) throw new Error('--data-dir requires a path.');
    dataDir = path.resolve(args[dataIndex + 1]); args.splice(dataIndex, 2);
  }
  const command = args.shift() || 'start';
  if (appMode && command !== 'login') throw new Error('--app is only supported for website login.');
  if (browserChannel && command !== 'login') throw new Error('--browser is only supported for website login.');
  if (['help', '--help', '-h'].includes(command)) {
    console.log('Gravity Web2API\n  setup                Create private configuration\n  login <website>      Optional browser token capture / dedicated profile setup\n  start                Start http://127.0.0.1:4320/v1\n  info [--json]        Local API key and Gravity managed profile\n  status               Local readiness (no inference)\n  models               Available website aliases (no inference)\n  probe <model-id>     Explicit short completion (uses website quota)\n  --data-dir <path>    Use a different private data directory');
    return;
  }
  if (!['setup', 'login', 'start', 'info', 'status', 'models', 'probe', 'browsers', 'browser', 'restore-site'].includes(command)) throw new Error('Unknown command. Automated tests use npm test; account inference uses npm run probe.');
  const expectedArgs = ['login', 'probe', 'browser', 'restore-site'].includes(command) ? 1 : ['info', 'browsers'].includes(command) && args[0] === '--json' ? 1 : 0;
  if (args.length !== expectedArgs) throw new Error('Invalid arguments. Use --help.');
  const config = await loadConfig(dataDir);
  const base = `http://127.0.0.1:${config.port}`;
  if (command === 'browsers') {
    console.log(JSON.stringify({ browserChannel: config.browserChannel, runtimeVersion: process.version, browsers: (await discoverInstalledBrowsers()).map(({ executable, ...browser }) => browser) }));
    return;
  }
  if (command === 'restore-site') {
    const siteId = args[0]; if (!browserSites[siteId]) throw new Error('Choose a supported website.');
    let payload = '', bytes = 0;
    for await (const chunk of stdin) { bytes += chunk.length; if (bytes > 65536) throw new Error('The recovery payload is too large.'); payload += chunk.toString(); }
    let recovery; try { recovery = JSON.parse(payload); } catch { throw new Error('Invalid recovery payload.'); }
    await updateConfig(dataDir, current => {
      if (JSON.stringify(current.providers[siteId]) !== JSON.stringify(recovery.expected)) throw new Error('The account settings changed during recovery. Keep the newer saved session.');
      validateConfig({ ...current, providers: { ...current.providers, [siteId]: recovery.previous } });
      current.providers[siteId] = recovery.previous;
    });
    console.log(JSON.stringify({ restored: true })); return;
  }
  if (command === 'browser') {
    const channel = args[0];
    if (!['chrome', 'msedge'].includes(channel)) throw new Error('Choose chrome or msedge.');
    await updateConfig(dataDir, current => {
      for (const provider of Object.values(current.providers)) if (provider.enabled && !provider.browserChannel) provider.browserChannel = current.browserChannel;
      current.browserChannel = channel;
    });
    console.log(JSON.stringify({ browserChannel: channel })); return;
  }
  if (command === 'setup') {
    console.log(`Configuration ready: ${path.join(dataDir, 'config.json')}\nDeepSeek/Qwen: set providers.<website>.enabled and token, or GRAVITY_DEEPSEEK_TOKEN / GRAVITY_QWEN_TOKEN. Browser login is optional.\nChatGPT/Z.ai: npm run login -- <chatgpt|zai> sets up a dedicated profile once.\nThen npm start. No paid model API key is required.`);
    return;
  }
  if (command === 'login') {
    if (!appMode) return login(args[0], config, dataDir, { browserChannel });
    const controller = new AbortController();
    const input = createInterface({ input: stdin, output: stdout });
    const cancel = () => controller.abort(new Error('Website setup cancelled.'));
    input.on('line', line => { if (line.trim() === 'cancel') cancel(); });
    input.on('close', cancel);
    process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
    try { return await login(args[0], config, dataDir, { appMode: true, signal: controller.signal, browserChannel, createInput: () => input }); }
    finally { input.close(); process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel); }
  }
  if (command === 'info') {
    const preset = gravityPreset(config, dataDir);
    if (args[0] === '--json') console.log(JSON.stringify(preset, null, 2));
    else console.log(`Provider: Gravity Web2API\nAPI URL: ${base}/v1\nLocal API key: ${config.apiToken}\nThis generated local key is separate from website credentials.\nManaged executable: ${preset.bridge.executable}\nArguments JSON: ${JSON.stringify(preset.bridge.args)}\nWorking directory: ${preset.bridge.cwd}\nHealth URL: ${preset.bridge.healthUrl}\nDiscover models in Gravity after starting the bridge.`);
    return;
  }
  if (['status', 'models', 'probe'].includes(command)) {
    const testing = command === 'probe';
    if (testing && !args[0]) throw new Error('Supply a model ID from /v1/models, such as qwen-web.');
    let response;
    try {
      response = await fetch(base + (testing ? '/v1/chat/completions' : command === 'models' ? '/v1/models' : '/status'), {
        method: testing ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(testing ? 180000 : 5000),
        headers: { Authorization: `Bearer ${config.apiToken}`, ...(testing ? { 'Content-Type': 'application/json' } : {}) },
        ...(testing ? { body: JSON.stringify({ model: args[0], messages: [{ role: 'user', content: 'Reply with only OK.' }] }) } : {}),
      });
    } catch { throw new Error('The local bridge is not reachable. Run npm start in another terminal.'); }
    const result = await localJson(response);
    if (!response.ok) throw new Error(`Local bridge returned HTTP ${response.status}. Check provider setup and npm run status.`);
    console.log(JSON.stringify(result, null, 2)); return;
  }
  const adapters = buildAdapters(config, dataDir);
  if (!adapters.length) throw new Error('No providers are enabled. Run npm run setup to see token/profile configuration options.');
  await discoverAccountModels(adapters, AbortSignal.timeout(25000));
  const server = createWebApiServer({ adapters, apiToken: config.apiToken, port: config.port });
  await server.start();
  const unavailable = adapters.filter(adapter => !adapter.available);
  console.log(`Gravity Web2API ready at ${base}/v1\nLoaded: ${adapters.filter(adapter => adapter.available).map(adapter => adapter.label).join(', ')}${unavailable.length ? `\nUnavailable: ${unavailable.map(adapter => adapter.label).join(', ')}. Sign in again or check the connection, then restart the bridge.` : ''}\nRun npm run info to copy the local API key. Account generation has not been tested.\nPress Ctrl+C to stop.`);
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    await server.stop(); await Promise.allSettled(adapters.map(adapter => adapter.close?.()));
  };
  process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.code === 'EADDRINUSE' ? 'Port is already in use. Stop the other bridge or change port in your private config.' : error.message); process.exitCode = 1; });
}
