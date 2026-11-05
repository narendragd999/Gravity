import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loginBrowserProfile } from '../bridges/multi-web2api/cli.mjs';
import { loadConfig } from '../bridges/multi-web2api/config.mjs';

async function fixture(t, { url = 'https://chat.z.ai/', history = 0, draft = '', directToken, cookieToken } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gravity-manual-flow-'));
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const config = await loadConfig(dataDir, {});
  const events = [], logs = [];
  let observedRequest;
  const page = {
    async goto(value) { events.push(['goto', value]); if (directToken && observedRequest) observedRequest({ url: () => `${new URL(url).origin}/api/fixture`, allHeaders: async () => ({ authorization: `Bearer ${directToken}` }) }); }, url: () => url,
    async reload() { await this.goto(url); },
    locator(selector) {
      return { count: async () => history, first: () => ({
        isVisible: async () => !/iframe|challenge|captcha/i.test(selector), isEnabled: async () => true,
        evaluate: async () => draft,
      }) };
    },
  };
  const context = { pages: () => [page], on(event, listener) { if (event === 'request') observedRequest = listener; }, off() { observedRequest = undefined; },
    cookies: async () => cookieToken ? [{ name: 'token', value: cookieToken }] : [], async close() { events.push('context-close'); } };
  const dependencies = {
    async openBrowser(options) { events.push(['manual-open', options]); return { waitForClose: Promise.resolve() }; },
    async openContext(options) { events.push(['verify-open', options]); return context; },
    createInput: () => ({ async question(text) { events.push(['question', text]); }, close() { events.push('input-close'); } }),
    log: text => logs.push(text), closeTimeoutMs: 10,
  };
  return { config, dataDir, dependencies, events, logs };
}

test('manual login waits for browser closure, verifies an empty chat and saves only selected provider', async t => {
  const f = await fixture(t);
  let finishBrowser;
  const closed = new Promise(resolve => { finishBrowser = resolve; });
  f.dependencies.openBrowser = async () => ({ waitForClose: closed });
  f.dependencies.createInput = () => ({ async question() {
    assert.equal((await loadConfig(f.dataDir, {})).providers.zai.enabled, false);
    assert.ok(!f.events.some(event => event[0] === 'verify-open'));
    finishBrowser();
  }, close() { f.events.push('input-close'); } });
  await loginBrowserProfile('zai', f.config, f.dataDir, f.dependencies);
  const saved = await loadConfig(f.dataDir, {});
  assert.equal(saved.providers.zai.enabled, true);
  assert.equal(saved.providers.chatgpt.enabled, false);
  assert.equal(saved.apiToken, f.config.apiToken);
  assert.deepEqual(saved.providers.qwen, f.config.providers.qwen);
  assert.ok(f.events.includes('context-close'));
  assert.ok(f.events.includes('input-close'));
  assert.ok(f.logs.some(text => text.includes('setup saved')));
});

test('Qwen and DeepSeek use normal sign-in, capture only their dedicated session and validate before saving', async t => {
  for (const [siteId, url] of [['qwen', 'https://chat.qwen.ai/'], ['deepseek', 'https://chat.deepseek.com/']]) {
    const token = `fixture-${siteId}-website-session-token`;
    const f = await fixture(t, { url, directToken: token });
    let checked = false;
    await loginBrowserProfile(siteId, f.config, f.dataDir, { ...f.dependencies, autoContinue: true,
      createDirectAdapter: (id, captured) => ({ async checkAuth({ signal }) {
        assert.equal(id, siteId); assert.equal(captured, token); assert.ok(signal);
        assert.equal((await loadConfig(f.dataDir, {})).providers[siteId].enabled, false); checked = true;
      } }) });
    const saved = await loadConfig(f.dataDir, {});
    assert.equal(checked, true); assert.equal(saved.providers[siteId].enabled, true);
    assert.equal(saved.providers[siteId].token, token); assert.equal(saved.providers[siteId].browserChannel, 'chrome');
    assert.ok(f.events.some(event => event[0] === 'manual-open'));
    assert.ok(!f.logs.join('').includes(token));
  }
});

test('failed direct-session authentication keeps the provider disabled and preserves another account', async t => {
  const f = await fixture(t, { url: 'https://chat.qwen.ai/', directToken: 'fixture-expired-qwen-session-token' });
  const stages = [];
  await assert.rejects(loginBrowserProfile('qwen', f.config, f.dataDir, { ...f.dependencies, autoContinue: true,
    report: (stage, type, code) => stages.push({ stage, type, code }),
    createDirectAdapter: () => ({ async checkAuth() { throw Object.assign(new Error('PRIVATE_TOKEN'), { status: 401 }); } }) }), { code: 'auth_expired' });
  assert.equal((await loadConfig(f.dataDir, {})).providers.qwen.enabled, false);
  assert.equal((await loadConfig(f.dataDir, {})).providers.qwen.token, undefined);
  assert.ok(stages.some(event => event.stage === 'checking-session' && event.code === 'auth_expired'));
});

test('verification reports the precise handoff failure rather than a generic login error', async t => {
  const f = await fixture(t, { url: 'https://accounts.google.com/v3/signin/rejected' });
  const events = [];
  await assert.rejects(loginBrowserProfile('chatgpt', f.config, f.dataDir, { ...f.dependencies, autoContinue: true,
    report: (stage, type, code) => events.push({ stage, type, code }) }), { code: 'oauth_rejected' });
  assert.deepEqual(events.at(-1), { stage: 'checking-session', type: 'error', code: 'oauth_rejected' });
  assert.ok(events.some(event => event.stage === 'releasing-profile'));
  assert.ok(events.some(event => event.stage === 'opening-profile'));
});

test('an open login browser times out without reopening or enabling the provider', async t => {
  const f = await fixture(t);
  f.dependencies.openBrowser = async () => ({ waitForClose: new Promise(() => {}) });
  await assert.rejects(loginBrowserProfile('zai', f.config, f.dataDir, f.dependencies), { code: 'browser_close_timeout' });
  assert.equal((await loadConfig(f.dataDir, {})).providers.zai.enabled, false);
  assert.ok(!f.events.some(event => event[0] === 'verify-open'));
  assert.ok(f.events.includes('input-close'));
});

test('failed manual browser launch never saves an account or opens an automated browser', async t => {
  const f = await fixture(t);
  f.dependencies.openBrowser = async () => { throw new Error('fixture missing browser'); };
  await assert.rejects(loginBrowserProfile('zai', f.config, f.dataDir, f.dependencies), { code: 'browser_launch_failed' });
  assert.equal((await loadConfig(f.dataDir, {})).providers.zai.enabled, false);
  assert.deepEqual(f.events, []);
});

test('login verification rejects OAuth redirects, restored chats and drafts without saving', async t => {
  for (const options of [{ url: 'https://accounts.google.com/' }, { url: 'https://chat.z.ai/c/old' }, { history: 1 }, { draft: 'keep this draft' }]) {
    const f = await fixture(t, options);
    await assert.rejects(loginBrowserProfile('zai', f.config, f.dataDir, f.dependencies), error => ['sign_in_required', 'new_chat_required', 'draft_present'].includes(error.code));
    assert.equal((await loadConfig(f.dataDir, {})).providers.zai.enabled, false);
    assert.ok(f.events.includes('context-close'));
    assert.ok(f.events.includes('input-close'));
    assert.ok(!f.logs.some(text => text.includes('setup saved')));
  }
});

test('browser driver errors do not leak private website details or change saved setup', async t => {
  const f = await fixture(t);
  f.dependencies.openContext = async () => { throw new Error('private cookie and account details'); };
  await assert.rejects(loginBrowserProfile('zai', f.config, f.dataDir, f.dependencies), error => error.code === 'verification_failed' && !error.message.includes('private cookie'));
  assert.equal((await loadConfig(f.dataDir, {})).providers.zai.enabled, false);
  assert.ok(f.events.includes('input-close'));
});

test('app login continues after normal browser closes without needing terminal input', async t => {
  const f = await fixture(t);
  f.dependencies.createInput = () => { throw new Error('App login must not open a terminal prompt'); };
  await loginBrowserProfile('zai', f.config, f.dataDir, { ...f.dependencies, autoContinue: true });
  assert.equal((await loadConfig(f.dataDir, {})).providers.zai.enabled, true);
  assert.ok(f.logs.some(text => text.includes('setup saved')));
});

test('cancelling app login while human browser is open keeps provider disabled', async t => {
  const f = await fixture(t), controller = new AbortController();
  let launched;
  const opened = new Promise(resolve => { launched = resolve; });
  f.dependencies.openBrowser = async () => { launched(); return { waitForClose: new Promise(() => {}) }; };
  const operation = loginBrowserProfile('zai', f.config, f.dataDir, { ...f.dependencies, autoContinue: true, signal: controller.signal });
  await opened;
  controller.abort(new Error('fixture cancelled'));
  await assert.rejects(operation, { code: 'setup_cancelled' });
  assert.equal((await loadConfig(f.dataDir, {})).providers.zai.enabled, false);
  assert.ok(!f.events.some(event => event[0] === 'verify-open'));
});

test('cancel during verification launch closes the returned context before saving', async t => {
  const f = await fixture(t), controller = new AbortController();
  let opened;
  const verificationStarted = new Promise(resolve => { opened = resolve; });
  let finishOpen;
  const pendingContext = new Promise(resolve => { finishOpen = resolve; });
  f.dependencies.openContext = () => { opened(); return pendingContext; };
  const operation = loginBrowserProfile('zai', f.config, f.dataDir, { ...f.dependencies, autoContinue: true, signal: controller.signal });
  await verificationStarted;
  controller.abort(new Error('fixture cancelled'));
  let closed = false;
  finishOpen({ close: async () => { closed = true; } });
  await assert.rejects(operation, { code: 'setup_cancelled' });
  assert.equal(closed, true);
  assert.equal((await loadConfig(f.dataDir, {})).providers.zai.enabled, false);
});
