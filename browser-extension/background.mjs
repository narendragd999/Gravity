import { CONNECTOR_ORIGIN, SITES, siteById, siteMatchesUrl, formatJobPrompt } from './core.mjs';
import { pageBridge } from './dom.mjs';

// Keep this aligned with the desktop's browser connector contract.
const CONNECTOR_PROTOCOL = 3;
const extensionVersion = chrome.runtime.getManifest().version;
let auth = null, pendingPair = null, initialized = false, initialization, looping = false, lastScan = 0, lastHeartbeat = 0;
let connection = 'disconnected', lastError = '';
let authGeneration = 0, ownedWrites = Promise.resolve(), connectionWrites = Promise.resolve();
const active = new Map();
let sites = SITES.map(site => ({ id: site.id, connected: false, busy: false, error: 'Open this service and sign in in Chrome.' }));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const cleanError = error => String(error?.message || error || 'Browser connector operation failed.').replaceAll(auth?.token || '\0', '[redacted]').slice(0, 700);

// Chrome can leave a read pending while a page is loading. A loop deadline alone
// cannot bound an awaited browser API call; timed-out reads are ignored if late.
function readWithin(operation, deadline, message, job) {
  return new Promise((resolve, reject) => {
    let finished = false, timer;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer); job?.pendingReads?.delete(cancel);
      if (error) reject(error); else resolve(value);
    };
    const cancelled = () => job && (job.cancelled || job.generation !== authGeneration);
    const cancel = () => finish(new Error('The application cancelled this browser request.'));
    if (cancelled()) { cancel(); return; }
    const remaining = deadline - Date.now();
    if (remaining <= 0) { finish(new Error(message)); return; }
    if (job) (job.pendingReads ??= new Set()).add(cancel);
    timer = setTimeout(() => finish(new Error(message)), remaining);
    Promise.resolve().then(operation).then(value => {
      if (cancelled()) cancel();
      else if (Date.now() >= deadline) finish(new Error(message));
      else finish(null, value);
    }, error => finish(error));
  });
}

async function persistOwned() {
  const ownedJobs = [...active.values()].filter(job => job.tabId !== undefined).map(({ id, siteId, tabId }) => ({ id, siteId, tabId }));
  ownedWrites = ownedWrites.catch(() => {}).then(() => chrome.storage.session.set({ ownedJobs }));
  await ownedWrites;
}
async function persistConnection() {
  const state = { connectorAuth: auth, pendingPair };
  connectionWrites = connectionWrites.catch(() => {}).then(() => chrome.storage.local.set(state));
  await connectionWrites;
}
async function rpc(path, body, { paired = true, timeout = 25000 } = {}) {
  const currentToken = auth?.token, generation = authGeneration;
  const ensureCurrent = () => { if (generation !== authGeneration || (paired && auth?.token !== currentToken)) throw new Error('The connector connection changed while this request was in flight.'); };
  if (paired && !currentToken) throw new Error('Connect this extension to Gravity first.');
  let response;
  try {
    response = await fetch(`${CONNECTOR_ORIGIN}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-connector-extension-id': chrome.runtime.id, 'x-connector-protocol': String(CONNECTOR_PROTOCOL), 'x-connector-version': extensionVersion, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(paired ? { authorization: `Bearer ${currentToken}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeout) });
  } catch { throw new Error('Cannot reach Gravity at 127.0.0.1:4319. Start its browser connector and retry.'); }
  ensureCurrent();
  let data; try { data = await response.json(); } catch { throw new Error('The local connector returned an invalid response.'); }
  ensureCurrent();
  if (!response.ok) {
    if (paired && response.status === 401 && auth?.token === currentToken) await disconnect('Pairing expired or was revoked. Connect again and approve it in the desktop app.');
    const error = new Error(data?.error?.message || data?.error || `Local connector returned HTTP ${response.status}.`); error.status = response.status; throw error;
  }
  await cancelJobs(data.cancelledJobIds || []);
  ensureCurrent();
  return data;
}
async function initialize() {
  if (initialized) return;
  if (initialization) return initialization;
  initialization = (async () => {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const saved = await chrome.storage.local.get(['connectorAuth', 'pendingPair']);
    auth = saved.connectorAuth?.token ? saved.connectorAuth : null;
    pendingPair = saved.pendingPair || null;
    connection = auth ? 'connecting' : pendingPair ? 'approval' : 'disconnected';
    const recovery = await chrome.storage.session.get('ownedJobs');
    // A restarted worker cannot safely reconstruct a partially submitted request.
    for (const job of recovery.ownedJobs || []) {
      const site = siteById(job.siteId);
      if (!site || !Number.isInteger(job.tabId)) continue;
      try { await readWithin(() => chrome.scripting.executeScript({ target: { tabId: job.tabId }, world: 'ISOLATED', injectImmediately: true, func: pageBridge, args: ['cancel', site, { id: job.id }] }), Date.now() + 1500, 'Chrome did not acknowledge cancellation.'); } catch { /* Tab may have closed or navigated to sign-in. */ }
      if (auth) try { await rpc('/connector/results', { id: job.id, siteId: job.siteId, error: 'The browser connector restarted before completing this request. Retry from the app.' }); } catch { /* Old jobs may already be cancelled. */ }
    }
    await chrome.storage.session.set({ ownedJobs: [] });
    initialized = true;
    await chrome.alarms.create('connector-wake', { periodInMinutes: 0.5 });
  })();
  try { await initialization; } finally { initialization = null; }
}
async function scanSites() {
  let tabs;
  try { tabs = await readWithin(() => chrome.tabs.query({ url: SITES.map(site => `https://${site.host}/*`) }), Date.now() + 3000, 'Chrome did not finish checking open tabs. Refresh the extension status and retry.'); }
  catch (error) {
    sites = SITES.map(site => [...active.values()].some(job => job.siteId === site.id && !job.cancelled)
      ? { id: site.id, connected: true, busy: true }
      : { id: site.id, connected: false, busy: false, error: cleanError(error) });
    lastScan = Date.now(); return;
  }
  sites = await Promise.all(SITES.map(async site => {
    if ([...active.values()].some(job => job.siteId === site.id && !job.cancelled)) return { id: site.id, connected: true, busy: true };
    const candidates = tabs.filter(tab => Number.isInteger(tab.id) && siteMatchesUrl(site.id, tab.url)).sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0)).slice(0, 3);
    let last = { connected: false, busy: false, error: 'Open this service and sign in in Chrome.' };
    for (const tab of candidates) {
      try {
        const result = (await readWithin(() => chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', injectImmediately: true, func: pageBridge, args: ['probe', site] }), Date.now() + 1500, 'Chrome did not finish checking this tab. Refresh the website and retry.'))[0]?.result;
        if (result?.connected) return { id: site.id, ...result };
        if (result) last = result;
      } catch (error) { last = { connected: false, busy: false, error: `${cleanError(error)} Allow extension access to this site, sign in, and refresh its tab.` }; }
    }
    return { id: site.id, ...last };
  }));
  lastScan = Date.now();
}
async function connect() {
  await initialize();
  if (auth) return publicState();
  if (active.size) throw new Error('Stop active browser requests before reconnecting.');
  const generation = ++authGeneration;
  auth = null; pendingPair = null; connection = 'connecting'; await persistConnection();
  if (generation !== authGeneration) return publicState();
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  const pair = await rpc('/connector/pair', { extensionId: chrome.runtime.id, nonce }, { paired: false, timeout: 10000 }).catch(error => {
    if (generation === authGeneration) { connection = 'disconnected'; lastError = cleanError(error); }
    throw error;
  });
  if (generation !== authGeneration) return publicState();
  if (typeof pair.id !== 'string') throw new Error('The desktop app returned an invalid pairing request.');
  const expires = typeof pair.expiresAt === 'number' ? pair.expiresAt : Date.parse(pair.expiresAt);
  pendingPair = { id: pair.id, nonce, expiresAt: Number.isFinite(expires) ? expires : Date.now() + 120000 };
  connection = 'approval'; lastError = ''; await persistConnection();
  if (generation === authGeneration) void loop(); return publicState();
}
async function pollPairing() {
  if (!pendingPair) return;
  const pending = pendingPair, generation = authGeneration;
  if (Date.now() > pending.expiresAt) { pendingPair = null; connection = 'disconnected'; await persistConnection(); throw new Error('Pairing expired. Select Connect and approve the new request in the app.'); }
  try {
    const result = await rpc('/connector/pair/status', { id: pending.id, nonce: pending.nonce }, { paired: false, timeout: 10000 });
    if (pending !== pendingPair || generation !== authGeneration) return;
    if (result.status === 'approved' && typeof result.token === 'string' && result.token.length >= 16) {
      auth = { token: result.token }; pendingPair = null; authGeneration++;
      connection = 'connecting'; lastScan = 0; lastHeartbeat = 0; lastError = '';
      await persistConnection();
    } else if (result.status && result.status !== 'pending') throw new Error('The desktop app rejected this pairing request.');
  } catch (error) {
    if (pending === pendingPair && generation === authGeneration && [400, 403, 404, 410].includes(error.status)) { pendingPair = null; connection = 'disconnected'; await persistConnection(); }
    throw error;
  }
}
async function cancelJobs(ids) {
  if (!Array.isArray(ids)) return;
  for (const id of ids) {
    const job = active.get(id); if (!job || job.cancelled) continue;
    job.cancelled = true;
    for (const cancel of job.pendingReads || []) cancel();
    if (job.tabId !== undefined) {
      try { await readWithin(() => chrome.scripting.executeScript({ target: { tabId: job.tabId }, world: 'ISOLATED', injectImmediately: true, func: pageBridge, args: ['cancel', siteById(job.siteId), { id }] }), Date.now() + 1500, 'Chrome did not acknowledge cancellation.'); } catch { /* Tab already closed. */ }
      try { await readWithin(() => chrome.tabs.remove(job.tabId), Date.now() + 1500, 'Chrome did not close the cancelled task tab.'); } catch { /* Only task-created tabs are removed. */ }
    }
  }
}
async function disconnect(reason = '') {
  authGeneration++; auth = null; pendingPair = null;
  connection = 'disconnected'; lastError = reason;
  await Promise.all([cancelJobs([...active.keys()]), persistConnection()]);
}
async function waitForTab(job) {
  const site = siteById(job.siteId), deadline = Math.min(Date.now() + 45000, job.deadline);
  let lastIssue = 'The page has not exposed its chat input yet.';
  while (Date.now() < deadline) {
    if (job.cancelled || job.generation !== authGeneration) throw new Error('The application cancelled this browser request.');
    const tab = await readWithin(() => chrome.tabs.get(job.tabId), Math.min(deadline, Date.now() + 3000), 'Chrome did not finish checking the task tab. No prompt was submitted. Retry from the app.', job);
    // A SPA can have a usable composer while trackers/resources keep Chrome loading.
    // Inspect only the expected site; the DOM runner separately rejects history/drafts.
    if (tab.url && tab.url !== 'about:blank') {
      if (!siteMatchesUrl(job.siteId, tab.url)) throw new Error('This service redirected to sign-in or another site. Complete sign-in yourself in Chrome, then retry.');
      const currentPath = new URL(tab.url).pathname.replace(/\/$/, '') || '/';
      const requestedPath = new URL(site.url).pathname.replace(/\/$/, '') || '/';
      if (currentPath !== requestedPath) throw new Error('The website reopened an existing conversation instead of a new chat. The connector left it untouched. Open a fresh chat on the website and retry.');
      try {
        const values = await readWithin(() => chrome.scripting.executeScript({ target: { tabId: job.tabId }, world: 'ISOLATED', injectImmediately: true, func: pageBridge, args: ['probe', site] }), Math.min(deadline, Date.now() + 1500), 'Chrome did not finish checking the chat input.', job);
        if (job.cancelled || job.generation !== authGeneration) throw new Error('The application cancelled this browser request.');
        const probe = values[0]?.result;
        if (probe?.connected && !probe.busy) return;
        lastIssue = probe?.error || (probe?.busy ? 'The website is already generating a response.' : 'No supported chat input was found.');
      } catch (error) {
        if (job.cancelled || job.generation !== authGeneration) throw error;
        lastIssue = cleanError(error);
        // Navigation can temporarily make script injection unavailable; poll again.
      }
    }
    await pause(250);
  }
  throw new Error(`${site.name} chat input was not ready within 45 seconds. ${lastIssue} No prompt was submitted. Open a new chat and sign in, then retry.`);
}
async function runJob(raw, generation = authGeneration) {
  if (!auth?.token || generation !== authGeneration) return;
  let job, success = false;
  try {
    const site = siteById(raw.siteId), prompt = formatJobPrompt(raw);
    if (active.has(raw.id)) return;
    if ([...active.values()].some(item => item.siteId === raw.siteId)) throw new Error('This service already has an active browser request.');
    job = { id: raw.id, siteId: raw.siteId, tabId: undefined, cancelled: false, generation, deadline: Date.now() + 170000 }; active.set(job.id, job);
    const tab = await chrome.tabs.create({ url: site.url, active: false }); job.tabId = tab.id; await persistOwned();
    if (job.cancelled || generation !== authGeneration) return;
    await waitForTab(job);
    if (job.cancelled || generation !== authGeneration) return;
    const timeoutMs = Math.min(160000, job.deadline - Date.now());
    if (timeoutMs <= 0) throw new Error('The browser request expired before its prompt could be submitted. Retry from the app.');
    // Submit only once. The absolute deadline also protects against delayed injection.
    const values = await readWithin(() => chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', injectImmediately: true, func: pageBridge, args: ['run', site, { id: job.id, prompt, timeoutMs, deadlineAt: job.deadline }] }), job.deadline, 'Chrome did not finish this browser request before its deadline. No completed response was accepted. Retry from the app.', job);
    if (job.cancelled || generation !== authGeneration) return;
    const response = values[0]?.result;
    if (!response?.text) throw new Error('The website did not return a completed assistant message.');
    await rpc('/connector/results', { id: job.id, siteId: job.siteId, rawText: response.text }); success = true;
  } catch (error) {
    if (!job?.cancelled && generation === authGeneration && auth && typeof raw?.id === 'string' && siteById(raw.siteId)) {
      try { await rpc('/connector/results', { id: raw.id, siteId: raw.siteId, error: cleanError(error) }); } catch { /* App may already have cancelled this request. */ }
    }
    if (!job?.cancelled) lastError = cleanError(error);
  } finally {
    if (job) {
      active.delete(job.id); await persistOwned();
      if ((success || job.cancelled) && job.tabId !== undefined) try { await chrome.tabs.remove(job.tabId); } catch { /* Already closed. */ }
    }
    // Failed task tabs stay open so the user can inspect sign-in or layout problems.
    lastScan = 0; lastHeartbeat = 0;
  }
}
async function loop() {
  await initialize(); if (looping) return; looping = true;
  try {
    while (auth || pendingPair) {
      try {
        if (pendingPair) await pollPairing();
        if (auth) {
          if (Date.now() - lastScan > 15000) await scanSites();
          if (Date.now() - lastHeartbeat > 12000) { await rpc('/connector/heartbeat', { sites }); lastHeartbeat = Date.now(); connection = 'connected'; lastError = ''; }
          const generation = authGeneration, { job } = await rpc('/connector/jobs');
          if (job) void runJob(job, generation);
        }
      } catch (error) { lastError = cleanError(error); if (auth) connection = 'offline'; await cancelJobs([...active.keys()]); }
      await pause(1800);
    }
  } finally { looping = false; }
}
function publicState() {
  return { connection, error: lastError, pairing: !!pendingPair, paired: !!auth, activeJobs: active.size, extensionVersion, protocol: CONNECTOR_PROTOCOL,
    sites: SITES.map(site => ({ id: site.id, name: site.name, model: site.model, ...sites.find(value => value.id === site.id), busy: [...active.values()].some(job => job.siteId === site.id) || !!sites.find(value => value.id === site.id)?.busy })) };
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  (async () => {
    await initialize();
    if (message?.type === 'status') { void loop(); return publicState(); }
    if (message?.type === 'connect') return connect();
    if (message?.type === 'disconnect') { await disconnect(); return publicState(); }
    if (message?.type === 'refresh') { await scanSites(); lastHeartbeat = 0; void loop(); return publicState(); }
    if (message?.type === 'open-site') {
      const site = siteById(message.siteId); if (!site) throw new Error('Unsupported website.');
      const matching = (await chrome.tabs.query({ url: `https://${site.host}/*` })).find(tab => siteMatchesUrl(site.id, tab.url));
      if (matching) await chrome.tabs.update(matching.id, { active: true }); else await chrome.tabs.create({ url: site.url, active: true });
      lastScan = 0; return publicState();
    }
    throw new Error('Unsupported connector action.');
  })().then(data => sendResponse({ ok: true, data })).catch(error => sendResponse({ ok: false, error: cleanError(error) }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'connector-wake') void loop(); });
chrome.runtime.onStartup.addListener(() => { void loop(); });
chrome.runtime.onInstalled.addListener(() => { void initialize(); });
void initialize().then(() => loop()).catch(error => { lastError = cleanError(error); });
