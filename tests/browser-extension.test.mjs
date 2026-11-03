import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { SITES, CONNECTOR_ORIGIN, siteById, siteForUrl, siteMatchesUrl, formatJobPrompt, parseSiteResult } from '../browser-extension/core.mjs';
import { pageBridge } from '../browser-extension/dom.mjs';

const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a project file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
const job = { id: 'fixture-job', siteId: 'claude', model: 'claude-web', messages: [{ role: 'user', content: 'Read the README.' }], tools };
const envelope = (overrides = {}) => JSON.stringify({ content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }], ...overrides });

test('extension manifest requests only scoped DOM access and trusted local connector access', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../browser-extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['scripting', 'storage', 'alarms']);
  assert.deepEqual(new Set(manifest.host_permissions), new Set([...SITES.map(site => `https://${site.host}/*`), `${CONNECTOR_ORIGIN}/*`]));
  assert.equal(manifest.background.type, 'module'); assert.equal(manifest.externally_connectable, undefined);
  assert.doesNotMatch(JSON.stringify(manifest), /<all_urls>|webRequest|debugger|nativeMessaging|"cookies"|"tabs"/);
  const dom = await fs.readFile(new URL('../browser-extension/dom.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(dom, /\bfetch\s*\(|XMLHttpRequest|document\.cookie|localStorage|sessionStorage|chrome\.cookies/);
});

test('all six website aliases map only to exact allowlisted HTTPS hosts', () => {
  assert.deepEqual(SITES.map(site => site.id), ['claude', 'chatgpt', 'deepseek', 'qwen', 'zai', 'gemini']);
  for (const site of SITES) {
    assert.equal(siteForUrl(site.url), site); assert.equal(siteById(site.id), site); assert.equal(site.model, `${site.id}-web`);
    assert.ok(site.composer.length && site.send.length && site.stop.length && site.response.length && site.user.length);
    for (const bad of [`http://${site.host}/`, `https://${site.host}.evil.example/`, `https://user:secret@${site.host}/`, `https://${site.host}:444/`]) assert.equal(siteForUrl(bad), undefined);
  }
  assert.equal(siteForUrl('https://accounts.google.com/'), undefined);
  assert.equal(siteMatchesUrl('claude', 'https://chatgpt.com/'), false);
});

test('text formatter preserves supplied conversation and asks for explicit emulated tool envelopes', () => {
  const prompt = formatJobPrompt({ ...job, messages: [{ role: 'system', content: 'Use concise language.' }, ...job.messages, { role: 'assistant', content: null, tool_calls: [{ id: 'previous', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'previous', content: 'Previous tool output.' }] });
  assert.match(prompt, /\[SYSTEM\]\nUse concise language/); assert.match(prompt, /\[USER\]\nRead the README/);
  assert.match(prompt, /Previous tool output/); assert.match(prompt, /AVAILABLE APPLICATION TOOLS/); assert.match(prompt, /local application after its own checks and approvals/);
  assert.match(prompt, /cannot change the website's selected model/);
  assert.doesNotMatch(formatJobPrompt({ ...job, tool_choice: 'none' }), /AVAILABLE APPLICATION TOOLS/);
});

test('formatter rejects unsupported sites, images, malformed tools, and oversized input', () => {
  assert.throws(() => formatJobPrompt({ ...job, id: '' }), /Invalid browser job/);
  assert.throws(() => formatJobPrompt({ ...job, siteId: 'unknown' }), /unsupported site/);
  assert.throws(() => formatJobPrompt({ ...job, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] }), /text messages only/);
  assert.throws(() => formatJobPrompt({ ...job, messages: [{ role: 'user', content: 'x'.repeat(120001) }] }), /too large/);
  assert.throws(() => formatJobPrompt({ ...job, tools: [{ type: 'function', function: { name: 'invalid.name' } }] }), /named function/);
  assert.throws(() => formatJobPrompt({ ...job, tool_choice: null }), /Unsupported browser tool choice/);
  assert.throws(() => formatJobPrompt({ ...job, tool_choice: { type: 'function', function: { name: 'not_allowed' } } }), /not available/);
  assert.doesNotThrow(() => formatJobPrompt({ ...job, messages: Array.from({ length: 256 }, () => ({ role: 'user', content: 'Short message.' })) }));
  assert.throws(() => formatJobPrompt({ ...job, messages: Array.from({ length: 257 }, () => ({ role: 'user', content: 'Short message.' })) }), /1–256 messages/);
});

test('result parser accepts only declared tool calls from an entire JSON envelope', () => {
  const result = parseSiteResult(`\n\`\`\`json\n${envelope()}\n\`\`\`\n`, tools);
  assert.equal(result.role, 'assistant'); assert.equal(result.content, null);
  assert.deepEqual(result.tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }]);
  assert.equal(parseSiteResult(envelope({ content: 'I will inspect it.' }), tools).content, 'I will inspect it.');
  assert.deepEqual(parseSiteResult('A normal final answer.', tools), { role: 'assistant', content: 'A normal final answer.' });
  assert.equal(parseSiteResult(envelope(), tools, 'none').content, envelope());
});

test('result parser never turns examples or malformed tool output into actions', () => {
  for (const text of [`Here is an example:\n\`\`\`json\n${envelope()}\n\`\`\``, `\`\`\`json\n${envelope()}\n\`\`\`\nNow I will explain.`, `\`\`\`json\n${envelope()}\n\`\`\`\n\`\`\`json\n${envelope()}\n\`\`\``, '{"tool_calls": [bad]}', '{"tool_calls": []}']) assert.throws(() => parseSiteResult(text, tools));
  assert.throws(() => parseSiteResult(envelope({ tool_calls: [{ id: 'x', type: 'function', function: { name: 'run_command', arguments: '{}' } }] }), tools), /undeclared/);
  assert.throws(() => parseSiteResult(envelope({ tool_calls: [{ id: 'x', type: 'function', function: { name: 'read_file', arguments: 'bad' } }] }), tools), /valid JSON/);
  assert.throws(() => parseSiteResult(envelope({ tool_calls: [{ id: 'x', type: 'function', function: { name: 'read_file', arguments: '[]' } }] }), tools), /JSON object/);
  assert.throws(() => parseSiteResult('No call.', tools, 'required'), /requested structured tool/);
});

async function workerFixture({ fetchResult, scriptResult, savedLocal = {}, savedSession = {}, savedTabs = [], advanceTime = false } = {}) {
  const local = { ...savedLocal }, session = { ...savedSession }, calls = [], requests = [], tabs = new Map(savedTabs.map(tab => [tab.id, tab])); let tabId = 100;
  let now = Date.now(), nextTimer = 0, pumping = false;
  const timers = new Map();
  const pumpTimers = () => {
    if (!advanceTime || pumping || !timers.size) return;
    pumping = true;
    // Let settled browser promises cancel their timeout before advancing time.
    setImmediate(() => {
      pumping = false;
      const pending = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!pending) return;
      const [id, timer] = pending; timers.delete(id); now = Math.max(now, timer.at);
      timer.callback(); pumpTimers();
    });
  };
  const storage = data => ({ async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in data).map(key => [key, data[key]])); }, async set(values) { Object.assign(data, values); }, async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }, async setAccessLevel(value) { calls.push(['accessLevel', value]); } });
  const chrome = {
    runtime: { id: 'abcdefghijklmnopabcdefghijklmnop', getManifest() { return { version: '1.0.2' }; }, onMessage: { addListener(listener) { calls.push(['listener', listener]); } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    alarms: { async create(...args) { calls.push(['alarm', ...args]); }, onAlarm: { addListener() {} } },
    storage: { local: storage(local), session: storage(session) },
    tabs: {
      async query(options) { calls.push(['query', options]); return [...tabs.values()]; },
      async create(options) { const tab = { id: ++tabId, status: 'complete', ...options }; tabs.set(tab.id, tab); calls.push(['create', options]); return tab; },
      async get(id) { if (!tabs.has(id)) throw new Error('Tab closed'); return tabs.get(id); },
      async update(id, options) { Object.assign(tabs.get(id), options); return tabs.get(id); },
      async remove(id) { tabs.delete(id); calls.push(['remove', id]); }
    },
    scripting: { async executeScript(options) { calls.push(['script', options.args[0], options.target.tabId, options]); return [{ result: scriptResult ? await scriptResult(options) : options.args[0] === 'run' ? { text: 'New fixture answer.' } : { connected: true, busy: false } }]; } }
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, SITES, CONNECTOR_ORIGIN, siteById, siteMatchesUrl, formatJobPrompt, parseSiteResult, pageBridge, URL, AbortSignal, console,
    Date: class extends Date { static now() { return advanceTime ? now : Date.now(); } },
    setTimeout(callback, delay = 0) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); pumpTimers(); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => { requests.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined }); const result = fetchResult ? await fetchResult(url, options) : { ok: true }; return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } }); }
  });
  const source = (await fs.readFile(new URL('../browser-extension/background.mjs', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/^void initialize\(\).*;\r?$/m, '');
  vm.runInContext(`${source}\n globalThis.testApi = {initialize,rpc,scanSites,runJob,cancelJobs,publicState,disconnect,pollPairing,persistOwned,setAuth(value){auth=value;authGeneration++;},setPendingPair(value){pendingPair=value;authGeneration++;},generation(){return authGeneration;},active};`, context);
  await context.testApi.initialize();
  return { ...context.testApi, calls, requests, tabs, local, session, chrome };
}

test('worker sends extension identity, version and protocol on every RPC and omits website credentials', async () => {
  const worker = await workerFixture(); worker.setAuth({ token: 'separate-local-pair-token' });
  await worker.rpc('/connector/pair/status', { id: 'pair', nonce: 'nonce' }, { paired: false });
  await worker.rpc('/connector/heartbeat', { sites: [] });
  for (const request of worker.requests) { assert.ok(request.url.startsWith(`${CONNECTOR_ORIGIN}/connector/`)); assert.equal(request.options.credentials, 'omit'); assert.equal(request.options.redirect, 'error'); assert.equal(request.options.headers['x-connector-extension-id'], worker.chrome.runtime.id); assert.equal(request.options.headers['x-connector-protocol'], '2'); assert.equal(request.options.headers['x-connector-version'], '1.0.2'); }
  assert.equal(worker.requests[0].options.headers.authorization, undefined);
  assert.equal(worker.requests[1].options.headers.authorization, 'Bearer separate-local-pair-token');
  assert.doesNotMatch(JSON.stringify(worker.publicState()), /separate-local-pair-token/);
  assert.equal(worker.publicState().extensionVersion, '1.0.2');
  assert.equal(worker.publicState().protocol, 2);
});

test('worker scans only allowed site URLs and creates a fresh owned tab per job', async () => {
  const worker = await workerFixture(); worker.setAuth({ token: 'separate-local-pair-token' });
  worker.tabs.set(9, { id: 9, url: 'https://claude.ai/chat/existing-user-conversation', status: 'complete' });
  await worker.scanSites();
  const query = worker.calls.find(call => call[0] === 'query')[1]; assert.deepEqual(Array.from(query.url), SITES.map(site => `https://${site.host}/*`));
  await worker.runJob({ ...job, tools: [] });
  const created = worker.calls.find(call => call[0] === 'create')[1];
  assert.equal(created.url, 'https://claude.ai/new'); assert.equal(created.active, false);
  assert.equal(worker.tabs.has(9), true, 'Existing conversation tab must remain untouched.');
  assert.equal(worker.tabs.size, 1, 'Only the successful task tab should be closed.');
  const result = worker.requests.find(request => request.url.endsWith('/results'));
  assert.equal(result.body.siteId, 'claude'); assert.equal(result.body.result.content, 'New fixture answer.');
});

test('worker refuses an existing-conversation redirect before injecting the prompt', async () => {
  const worker = await workerFixture(); worker.setAuth({ token: 'separate-local-pair-token' });
  const create = worker.chrome.tabs.create;
  worker.chrome.tabs.create = async options => { const tab = await create(options); tab.url = 'https://claude.ai/chat/restored-conversation'; return tab; };
  await worker.runJob({ ...job, tools: [] });
  assert.equal(worker.calls.some(call => call[0] === 'script' && call[1] === 'run'), false);
  assert.match(worker.requests.find(request => request.url.endsWith('/results')).body.error, /existing conversation/);
});

test('Qwen and Z.ai submit once when the composer is ready while Chrome still reports loading', async () => {
  for (const siteId of ['qwen', 'zai']) {
    const worker = await workerFixture(); worker.setAuth({ token: 'fixture-token' });
    const create = worker.chrome.tabs.create;
    worker.chrome.tabs.create = async options => { const tab = await create(options); tab.status = 'loading'; return tab; };
    await worker.runJob({ ...job, id: `loading-${siteId}`, siteId, model: `${siteId}-web`, tools: [] });
    const operations = worker.calls.filter(call => call[0] === 'script').map(call => call[1]);
    assert.deepEqual(operations, ['probe', 'run']);
    for (const call of worker.calls.filter(call => call[0] === 'script')) assert.equal(call[3].injectImmediately, true, 'Loading pages are inspected and submitted without waiting for document_idle');
    assert.equal(worker.requests.find(request => request.body?.result)?.body.siteId, siteId);
    assert.equal(worker.active.size, 0); assert.equal(worker.tabs.size, 0);
  }
});

test('worker waits for a delayed composer and reduces the remaining generation budget', async () => {
  let probes = 0, runPayload;
  const worker = await workerFixture({ advanceTime: true, scriptResult: options => {
    if (options.args[0] === 'probe') return { connected: ++probes > 100, busy: false };
    runPayload = options.args[2]; return { text: 'Delayed ready answer.' };
  } });
  worker.setAuth({ token: 'fixture-token' });
  await worker.runJob({ ...job, tools: [] });
  assert.equal(probes, 101); assert.equal(runPayload.timeoutMs, 145000);
  assert.ok(Number.isFinite(runPayload.deadlineAt), 'A late injection receives the absolute request deadline');
  assert.equal(worker.calls.filter(call => call[0] === 'script' && call[1] === 'run').length, 1);
  assert.ok(worker.requests.some(request => request.body?.result));
});

test('worker reports composer readiness failure without submitting or claiming completion', async () => {
  const worker = await workerFixture({ advanceTime: true, scriptResult: () => ({ connected: false, busy: false, error: 'Sign in to the website.' }) });
  worker.setAuth({ token: 'fixture-token' });
  await worker.runJob({ ...job, tools: [] });
  assert.equal(worker.calls.some(call => call[0] === 'script' && call[1] === 'run'), false);
  const result = worker.requests.find(request => request.url.endsWith('/results')).body;
  assert.equal(result.result, undefined); assert.match(result.error, /45 seconds.*Sign in.*No prompt was submitted/);
  assert.equal(worker.active.size, 0); assert.equal(worker.tabs.size, 1, 'Failure tab remains available for inspection');
});

test('worker rejects a foreign redirect before probing or sending', async () => {
  const worker = await workerFixture(); worker.setAuth({ token: 'fixture-token' });
  const create = worker.chrome.tabs.create;
  worker.chrome.tabs.create = async options => { const tab = await create(options); tab.url = 'https://accounts.example.com/signin'; tab.status = 'loading'; return tab; };
  await worker.runJob({ ...job, tools: [] });
  assert.equal(worker.calls.some(call => call[0] === 'script'), false);
  assert.match(worker.requests.find(request => request.url.endsWith('/results')).body.error, /redirected to sign-in/);
});

test('cancelling while readiness is being checked never submits the prompt', async () => {
  let finishProbe;
  const worker = await workerFixture({ scriptResult: options => options.args[0] === 'probe' ? new Promise(resolve => { finishProbe = resolve; }) : { cancelled: false } });
  worker.setAuth({ token: 'fixture-token' });
  const running = worker.runJob({ ...job, tools: [] });
  for (let i = 0; i < 40 && !finishProbe; i++) await Promise.resolve();
  assert.ok(finishProbe);
  await worker.cancelJobs([job.id]); await running;
  finishProbe({ connected: true, busy: false }); await Promise.resolve();
  assert.equal(worker.calls.some(call => call[0] === 'script' && call[1] === 'run'), false);
  assert.equal(worker.requests.some(request => request.body?.result), false);
  assert.equal(worker.active.size, 0); assert.equal(worker.tabs.size, 0);
});

test('hung scan queries and probes settle so heartbeats can continue', async () => {
  for (const hanging of ['query', 'probe']) {
    const worker = await workerFixture({ advanceTime: true, scriptResult: options => options.args[0] === 'probe' ? new Promise(() => {}) : { cancelled: true } });
    worker.setAuth({ token: 'fixture-token' });
    worker.tabs.set(9, { id: 9, url: 'https://claude.ai/new', status: 'loading' });
    worker.active.set('busy-job', { id: 'busy-job', siteId: 'qwen', generation: worker.generation(), cancelled: false });
    if (hanging === 'query') worker.chrome.tabs.query = () => new Promise(() => {});
    await worker.scanSites();
    const state = worker.publicState();
    assert.match(state.sites.find(site => site.id === 'claude').error, /Chrome did not finish checking/);
    assert.equal(state.sites.find(site => site.id === 'qwen').connected, true, 'An unrelated scan failure does not disconnect an active job');
    await worker.rpc('/connector/heartbeat', { sites: state.sites });
    assert.ok(worker.requests.some(request => request.url.endsWith('/heartbeat')));
    assert.equal(worker.calls.some(call => call[0] === 'script' && call[1] === 'run'), false);
  }
});

test('hung readiness reads expire without submitting a late or duplicate prompt', async () => {
  for (const hanging of ['get', 'probe']) {
    const worker = await workerFixture({ advanceTime: true, scriptResult: options => options.args[0] === 'probe' ? new Promise(() => {}) : { cancelled: true } });
    worker.setAuth({ token: 'fixture-token' });
    if (hanging === 'get') worker.chrome.tabs.get = () => new Promise(() => {});
    await worker.runJob({ ...job, tools: [] });
    assert.equal(worker.calls.some(call => call[0] === 'script' && call[1] === 'run'), false);
    const result = worker.requests.find(request => request.url.endsWith('/results')).body;
    assert.match(result.error, /No prompt was submitted/);
    assert.equal(result.result, undefined); assert.equal(worker.active.size, 0);
  }
});

test('worker cancellation stops only its owned task and never submits duplicate prompt jobs', async () => {
  let finish;
  const worker = await workerFixture({ scriptResult: options => options.args[0] === 'run' ? new Promise(resolve => { finish = resolve; }) : options.args[0] === 'probe' ? { connected: true, busy: false } : { cancelled: true } });
  worker.setAuth({ token: 'separate-local-pair-token' }); worker.tabs.set(9, { id: 9, url: 'https://claude.ai/new', status: 'complete' });
  const running = worker.runJob({ ...job, tools: [] });
  for (let i = 0; i < 30 && !finish; i++) await Promise.resolve();
  assert.ok(finish); await worker.runJob({ ...job, tools: [] });
  assert.equal(worker.calls.filter(call => call[0] === 'create').length, 1);
  await worker.cancelJobs([job.id]); finish({ text: 'Ignored cancelled answer.' }); await running;
  assert.equal(worker.tabs.has(9), true); assert.equal(worker.active.size, 0);
  assert.equal(worker.requests.some(request => request.body?.result), false);
});

test('a never-resolving run injection is cancelled without blocking the site or resubmitting', async () => {
  let started = false;
  const worker = await workerFixture({ scriptResult: options => {
    if (options.args[0] === 'run') { started = true; return new Promise(() => {}); }
    return options.args[0] === 'probe' ? { connected: true, busy: false } : { cancelled: true };
  } });
  worker.setAuth({ token: 'fixture-token' });
  const running = worker.runJob({ ...job, tools: [] });
  for (let i = 0; i < 60 && !started; i++) await Promise.resolve();
  assert.equal(started, true);
  await worker.runJob({ ...job, tools: [] });
  await worker.cancelJobs([job.id]); await running;
  assert.equal(worker.calls.filter(call => call[0] === 'script' && call[1] === 'run').length, 1);
  assert.equal(worker.requests.some(request => request.url.endsWith('/results')), false);
  assert.equal(worker.active.size, 0); assert.equal(worker.tabs.size, 0);
});

test('a never-resolving run injection expires once without accepting a response', async () => {
  const worker = await workerFixture({ advanceTime: true, scriptResult: options => options.args[0] === 'run' ? new Promise(() => {}) : { connected: true, busy: false } });
  worker.setAuth({ token: 'fixture-token' });
  await worker.runJob({ ...job, tools: [] });
  assert.equal(worker.calls.filter(call => call[0] === 'script' && call[1] === 'run').length, 1);
  const results = worker.requests.filter(request => request.url.endsWith('/results'));
  assert.equal(results.length, 1); assert.equal(results[0].body.result, undefined);
  assert.match(results[0].body.error, /before its deadline.*No completed response was accepted/);
  assert.equal(worker.active.size, 0); assert.equal(worker.tabs.size, 1, 'Failed task remains available for inspection');
});

test('disconnect invalidates in-flight job fetches and blocks jobs from an earlier pairing', async () => {
  let finish;
  const worker = await workerFixture({ fetchResult: () => new Promise(resolve => { finish = resolve; }) });
  worker.setAuth({ token: 'old-pairing-token' }); const generation = worker.generation();
  const stale = assert.rejects(worker.rpc('/connector/jobs'), /connection changed/);
  await worker.disconnect(); finish({ job }); await stale;
  await worker.runJob(job);
  worker.setAuth({ token: 'replacement-pairing-token' });
  await worker.runJob(job, generation);
  assert.equal(worker.calls.some(call => call[0] === 'create'), false);
  assert.equal(worker.active.size, 0);
  assert.equal(worker.local.connectorAuth, null);
});

test('late pairing approval cannot reconnect after the user disconnects', async () => {
  let finish;
  const worker = await workerFixture({ fetchResult: () => new Promise(resolve => { finish = resolve; }) });
  worker.setPendingPair({ id: 'pending-pair', nonce: 'random-nonce', expiresAt: Date.now() + 10000 });
  const stale = assert.rejects(worker.pollPairing(), /connection changed/);
  await worker.disconnect(); finish({ status: 'approved', token: 'late-pairing-token-must-be-ignored' }); await stale;
  assert.equal(worker.publicState().paired, false); assert.equal(worker.publicState().pairing, false);
  assert.equal(worker.local.connectorAuth, null); assert.equal(worker.local.pendingPair, null);
});

test('owned-tab recovery writes are serialized so an old snapshot cannot replace cleanup', async () => {
  const worker = await workerFixture(); const snapshots = []; let release;
  const original = worker.chrome.storage.session.set;
  worker.chrome.storage.session.set = async value => {
    snapshots.push(value);
    if (snapshots.length === 1) await new Promise(resolve => { release = resolve; });
    await original(value);
  };
  worker.active.set('a', { id: 'a', siteId: 'claude', tabId: 12 });
  const pending = worker.persistOwned();
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
  assert.ok(release);
  worker.active.clear(); const cleanup = worker.persistOwned();
  await Promise.resolve(); assert.equal(snapshots.length, 1);
  release(); await Promise.all([pending, cleanup]);
  assert.equal(snapshots.length, 2); assert.equal(worker.session.ownedJobs.length, 0);
});

test('worker restart cancels only recorded task tabs and reports failure without resubmitting', async () => {
  const worker = await workerFixture({
    savedLocal: { connectorAuth: { token: 'restart-pairing-token' } },
    savedSession: { ownedJobs: [{ id: 'interrupted-job', siteId: 'claude', tabId: 12 }] },
    savedTabs: [{ id: 9, url: 'https://claude.ai/chat/user-conversation' }, { id: 12, url: 'https://claude.ai/chat/task-conversation' }]
  });
  assert.equal(worker.calls.some(call => call[0] === 'create' || (call[0] === 'script' && call[1] === 'run')), false);
  const cancelled = worker.calls.filter(call => call[0] === 'script' && call[1] === 'cancel');
  assert.equal(cancelled.length, 1); assert.equal(cancelled[0][2], 12);
  assert.match(worker.requests.find(request => request.url.endsWith('/results')).body.error, /restarted/);
  assert.equal(worker.session.ownedJobs.length, 0); assert.equal(worker.tabs.has(9), true);
});

test('server revocation clears pairing and cancels the task before returning unauthorized', async () => {
  const worker = await workerFixture({ fetchResult: () => new Response(JSON.stringify({ error: { message: 'Pairing was revoked.' } }), { status: 401 }) });
  worker.setAuth({ token: 'revoked-pairing-token' });
  worker.tabs.set(12, { id: 12, url: 'https://claude.ai/new' });
  worker.active.set('revoked-job', { id: 'revoked-job', siteId: 'claude', tabId: 12, cancelled: false });
  await assert.rejects(worker.rpc('/connector/heartbeat', { sites: [] }), /revoked/);
  assert.equal(worker.publicState().paired, false); assert.equal(worker.local.connectorAuth, null);
  assert.equal(worker.tabs.has(12), false); assert.equal(worker.active.get('revoked-job').cancelled, true);
});
