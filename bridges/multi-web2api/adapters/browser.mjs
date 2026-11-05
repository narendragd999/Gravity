import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { bridgeError, parseChatGPTStream, parseZaiStream, RESPONSE_BYTES } from './browser-stream.mjs';

export const browserSites = Object.freeze({
  chatgpt: { label: 'ChatGPT', url: 'https://chatgpt.com/', model: 'chatgpt-web',
    completion: /^\/backend-api\/(?:f\/)?conversation\/?$/,
    composer: ['#prompt-textarea[contenteditable="true"]', '#prompt-textarea textarea', 'textarea#prompt-textarea', 'main [contenteditable="true"][role="textbox"]'],
    send: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]'],
    history: '[data-message-author-role="user"], [data-message-author-role="assistant"]', parse: parseChatGPTStream },
  zai: { label: 'Z.ai', url: 'https://chat.z.ai/', model: 'zai-web',
    completion: /^\/api\/v[12]\/chat\/completions\/?$/,
    composer: ['textarea#chat-input', '#chat-input[contenteditable="true"]', 'textarea[placeholder*="Ask"]', 'textarea[placeholder*="Message"]', '[contenteditable="true"][role="textbox"]'],
    send: ['#send-message-button', 'button[aria-label="Send message"]', 'button[aria-label="Send"]'],
    history: '[data-message-author-role="user"], [data-role="user"], .user-message, [data-message-author-role="assistant"], [data-role="assistant"], .assistant-message', parse: parseZaiStream },
  deepseek: { label: 'DeepSeek', url: 'https://chat.deepseek.com/' },
  qwen: { label: 'Qwen', url: 'https://chat.qwen.ai/' },
});

export async function ensureProfileDirectory({ siteId, dataDir }) {
  if (!browserSites[siteId]) throw bridgeError('Unknown website.', 400);
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw bridgeError('Choose a private bridge data directory.', 400);
  const root = path.resolve(dataDir);
  const folder = path.join(root, 'browsers', siteId);
  for (const directory of [root, path.join(root, 'browsers'), folder]) {
    let stat;
    try { stat = await fs.lstat(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw bridgeError('Bridge browser folders must be regular private directories.', 400, 'invalid_profile_directory');
    if (!stat) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const real = await fs.realpath(directory);
    const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (normalize(real) !== normalize(directory)) throw bridgeError('Bridge browser folders must not follow links into another profile.', 400, 'invalid_profile_directory');
  }
  return folder;
}

export async function openProfile({ siteId, dataDir, channel = 'chrome', headless = false, executablePath, playwright }) {
  if (!['chrome', 'msedge'].includes(channel)) throw bridgeError('Browser channel must be chrome or msedge.', 400);
  const folder = await ensureProfileDirectory({ siteId, dataDir });
  let chromium;
  try { ({ chromium } = playwright || await import('playwright-core')); }
  catch { throw bridgeError('Run npm ci in bridges/multi-web2api to install its browser driver.', 503, 'setup_required'); }
  try {
    return await chromium.launchPersistentContext(folder, { channel, headless, ...(executablePath ? { executablePath } : {}), chromiumSandbox: true, viewport: { width: 1280, height: 900 }, acceptDownloads: false });
  } catch (error) {
    if (/ProcessSingleton|SingletonLock|already in use|user.data.directory.*in use|profile.*in use/i.test(error?.message || '')) {
      throw bridgeError('The browser for this account is already open. Close its separate windows and try again.', 503, 'profile_busy');
    }
    throw bridgeError('Could not open the bridge browser. Install Chrome or Edge, and close any bridge login window using this same profile.', 503, 'browser_unavailable');
  }
}

async function firstReady(page, selectors) {
  for (const selector of selectors) {
    const item = page.locator(selector).first();
    if (await item.isVisible().catch(() => false) && await item.isEnabled().catch(() => false)) return item;
  }
  return null;
}

export async function visibleChallenge(page) {
  for (const selector of ['iframe[src*="challenges.cloudflare.com"]', 'iframe[title*="challenge" i]', '#challenge-running', '[data-testid="captcha"]']) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

export function requestMatches(request, siteId, prompt) {
  const site = browserSites[siteId];
  if (!site?.completion || request.method() !== 'POST') return false;
  let url;
  try { url = new URL(request.url()); } catch { return false; }
  if (url.origin !== new URL(site.url).origin || !site.completion.test(url.pathname)) return false;
  let payload;
  try { payload = request.postDataJSON(); } catch { return false; }
  const messages = payload?.messages;
  return Array.isArray(messages) && messages.some(message => (message.role === 'user' || message.author?.role === 'user') &&
    (message.content === prompt || message.content?.parts?.some(part => part === prompt)));
}

// Chrome keeps a bounded resource buffer. Decoded dataReceived byte counts also
// stop oversized responses while loading; Node never asks for an unbounded body.
export async function captureBrowserResponse(page, siteId, prompt, signal, { timeoutMs = 170000 } = {}) {
  const site = browserSites[siteId];
  const session = await page.context().newCDPSession(page);
  try { await session.send('Network.enable', { maxTotalBufferSize: RESPONSE_BYTES * 2, maxResourceBufferSize: RESPONSE_BYTES, maxPostDataSize: 512 * 1024 }); }
  catch { await session.detach().catch(() => {}); throw bridgeError('The installed browser does not support bounded network capture.', 503, 'browser_unavailable'); }
  let requestId, received = 0, headersReady = false, settled = false, resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  const fail = (error, closePage = false) => {
    if (settled) return;
    settled = true; reject(error);
    if (closePage) void page.close().catch(() => {});
  };
  const onRequest = event => {
    if (event.requestId === requestId && event.redirectResponse) { fail(bridgeError(`${site.label} redirected the completion request. No answer was accepted.`)); return; }
    if (requestId) return;
    const request = event.request;
    const shim = { method: () => request.method, url: () => request.url, postDataJSON: () => JSON.parse(request.postData || 'null') };
    if (requestMatches(shim, siteId, prompt)) requestId = event.requestId;
  };
  const onResponse = event => {
    if (event.requestId !== requestId || settled) return;
    const response = event.response;
    if (response.status < 200 || response.status >= 300) { fail(bridgeError(`${site.label} returned HTTP ${response.status}. Check its login browser before retrying.`, response.status === 429 ? 429 : 502)); return; }
    const headers = Object.fromEntries(Object.entries(response.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
    if (!(headers['content-type'] || response.mimeType || '').toLowerCase().startsWith('text/event-stream')) { fail(bridgeError(`${site.label} did not return an event stream. Complete any login/security check in its browser.`, 503, 'login_required')); return; }
    if (headers['content-length'] && (!/^\d+$/.test(headers['content-length']) || Number(headers['content-length']) > RESPONSE_BYTES)) { fail(bridgeError('Website response exceeded the supported size.', 502, 'response_too_large'), true); return; }
    headersReady = true;
  };
  const onData = event => {
    if (event.requestId !== requestId || settled) return;
    received += event.dataLength;
    if (!Number.isFinite(received) || received > RESPONSE_BYTES) fail(bridgeError('Website response exceeded the supported size.', 502, 'response_too_large'), true);
  };
  const onFinished = event => {
    if (event.requestId !== requestId || settled) return;
    if (!headersReady) { fail(bridgeError('The website response could not be correlated with this request.')); return; }
    void session.send('Network.getResponseBody', { requestId }).then(result => {
      if (settled) return;
      const bytes = result.base64Encoded ? Buffer.from(result.body, 'base64') : Buffer.from(result.body, 'utf8');
      if (bytes.length > RESPONSE_BYTES) throw bridgeError('Website response exceeded the supported size.', 502, 'response_too_large');
      let raw;
      try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw bridgeError('The website returned malformed text. No completed answer was accepted.', 502, 'malformed_response'); }
      const answer = site.parse(raw);
      settled = true; resolve(answer);
    }).catch(error => fail(Number.isInteger(error.status) && error.code ? error : bridgeError(`${site.label} response could not be captured within its supported limits. No partial reply was accepted.`, 502, 'incomplete_response')));
  };
  const onFailed = event => { if (event.requestId === requestId) fail(bridgeError(`${site.label} response was interrupted. No partial reply was accepted.`, 502, 'incomplete_response')); };
  const onAbort = () => fail(signal.reason, true);
  const onClose = () => fail(signal?.aborted ? signal.reason : bridgeError(`${site.label} browser closed before the response completed.`, 502, 'incomplete_response'));
  const handlers = { 'Network.requestWillBeSent': onRequest, 'Network.responseReceived': onResponse, 'Network.dataReceived': onData, 'Network.loadingFinished': onFinished, 'Network.loadingFailed': onFailed };
  for (const [name, handler] of Object.entries(handlers)) session.on(name, handler);
  page.on('close', onClose);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => fail(bridgeError(`${site.label} response timed out. The request was not retried.`, 504, 'timeout'), true), timeoutMs);
  if (signal?.aborted) onAbort();
  return { promise, async dispose() {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort); page.off('close', onClose);
    for (const [name, handler] of Object.entries(handlers)) session.off(name, handler);
    fail(bridgeError('The browser request ended before capture completed.', 502, 'incomplete_response'));
    await session.detach().catch(() => {});
  } };
}

export async function runBrowserTurn(page, siteId, prompt, signal, options = {}) {
  const site = browserSites[siteId];
  if (!site?.completion) throw bridgeError('This website uses the direct-request adapter.', 400);
  signal?.throwIfAborted();
  const abort = () => { void page.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  let capture;
  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const deadline = Date.now() + 30000;
    let composer;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (await visibleChallenge(page)) throw bridgeError(`${site.label} needs a manual security check. Run npm run login -- ${siteId} and complete it yourself.`, 503, 'login_required');
      composer = await firstReady(page, site.composer);
      if (composer) break;
      await pause(300, undefined, { signal });
    }
    if (!composer) throw bridgeError(`${site.label} is not ready. Run npm run login -- ${siteId}, sign in, and open a new chat.`, 503, 'login_required');
    const location = new URL(page.url());
    if (location.origin !== new URL(site.url).origin || !['', '/'].includes(location.pathname)) throw bridgeError(`${site.label} opened an existing conversation or sign-in page. No prompt was submitted.`, 503, 'new_chat_required');
    if (await page.locator(site.history).count()) throw bridgeError(`${site.label} restored conversation history. Open a new chat in its login browser first.`, 503, 'new_chat_required');
    const draft = await composer.evaluate(element => ('value' in element ? element.value : element.textContent) || '');
    if (draft.trim()) throw bridgeError(`${site.label} restored a draft. Clear or save it in its login browser first.`, 409, 'draft_present');
    const send = await firstReady(page, site.send);
    // Match only the POST that contains this exact new user prompt. Background
    // requests, unrelated chats and stale responses can never satisfy this turn.
    capture = await captureBrowserResponse(page, siteId, prompt, signal, options);
    await composer.fill(prompt, { timeout: 10000 });
    signal?.throwIfAborted();
    const readySend = send || await firstReady(page, site.send);
    if (readySend) await readySend.click({ timeout: 10000 });
    else await composer.press('Enter', { timeout: 10000 });
    return await capture.promise;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 && error.code) throw error;
    throw bridgeError(`${site.label} browser request failed. No automatic retry was submitted.`, 502, 'browser_request_failed');
  } finally {
    if (capture) await capture.dispose();
    signal?.removeEventListener('abort', abort);
  }
}

export function createBrowserAdapter({ siteId, dataDir, channel = 'chrome', profileOpener = openProfile }) {
  const site = browserSites[siteId];
  if (!site?.completion) throw bridgeError('Unsupported browser adapter.', 400);
  let context, opening;
  const getContext = async () => {
    if (context) return context;
    if (!opening) opening = profileOpener({ siteId, dataDir, channel }).then(value => {
      context = value; context.on('close', () => { if (context === value) context = null; }); return context;
    }).finally(() => { opening = null; });
    return opening;
  };
  return {
    id: siteId, label: site.label, models: [{ id: site.model, name: `${site.label} · selected website model` }],
    profileStatus() { return { browserProfileOpen: !!context || !!opening }; },
    async complete({ model, prompt }, { signal }) {
      if (model !== site.model) throw bridgeError('Unsupported website model alias.', 400);
      const browser = await getContext(); signal?.throwIfAborted();
      const page = await browser.newPage();
      try { return await runBrowserTurn(page, siteId, prompt, signal); }
      finally { await page.close().catch(() => {}); }
    },
    async close() { if (opening) await opening.catch(() => {}); const prior = context; context = null; if (prior) await prior.close(); },
  };
}
