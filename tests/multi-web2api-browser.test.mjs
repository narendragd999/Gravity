import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { decodeEvents, parseChatGPTStream, parseZaiStream, RESPONSE_BYTES } from '../bridges/multi-web2api/adapters/browser-stream.mjs';
import { captureBrowserResponse, requestMatches, runBrowserTurn, openProfile } from '../bridges/multi-web2api/adapters/browser.mjs';
import { capturedFromLiveAccount, editedReasoningGreeting, greeting, replacedReasoningGreeting, splitReasoningGreeting } from './fixtures/zai-protocol.mjs';

const sse = values => values.map(value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`).join('');
const assistant = (parts = [''], extra = {}) => ({ author: { role: 'assistant' }, content: { content_type: 'text', parts }, status: 'in_progress', end_turn: false, ...extra });
const completeGPT = text => sse([{ message: assistant([text], { status: 'finished_successfully', end_turn: true, channel: 'final' }) }, '[DONE]']);
const patchGPT = () => sse([
  { o: 'add', p: '', v: { message: assistant() } },
  { o: 'append', p: '/message/content/parts/0', v: 'Hello' }, { v: ' world' },
  { o: 'patch', v: [{ o: 'add', p: '/message/content/parts/1', v: '!' }, { o: 'replace', p: '/message/status', v: 'finished_successfully' }, { o: 'replace', p: '/message/end_turn', v: true }] }, '[DONE]',
]);

test('ChatGPT folds snapshots, compressed inherited patches and array parts', () => {
  assert.equal(parseChatGPTStream(patchGPT()), 'Hello world!');
  const text = 'Example: <tool_call>{"name":"read"}</tool_call>\n```html\n<div>text</div>\n```';
  assert.equal(parseChatGPTStream(completeGPT(text)), text);
  assert.equal(parseChatGPTStream(sse([{ message: assistant(['scratch'], { channel: 'analysis' }) }, { v: { message: assistant(['final'], { status: 'finished_successfully', channel: 'final' }) } }, '[DONE]'])), 'final');
});

test('ChatGPT rejects incomplete, nonfinal, malformed and oversized results', () => {
  for (const raw of [sse([{ message: assistant(['partial']) }, '[DONE]']), sse([{ message: assistant(['reasoning'], { status: 'finished_successfully', channel: 'analysis' }) }, '[DONE]']), sse([{ message: assistant(['tool data'], { status: 'finished_successfully', recipient: 'browser' }) }, '[DONE]']), sse([{ message: assistant(['text']) }, { o: 'replace', p: '/message/content/parts/9', v: 'invalid' }, '[DONE]']), completeGPT('text') + sse([{ message: assistant(['late']) }]), completeGPT('x'.repeat(200001))]) assert.throws(() => parseChatGPTStream(raw));
  assert.throws(() => parseChatGPTStream(sse([{ error: { message: 'private account token' } }])), error => !error.message.includes('private account token'));
});

test('SSE framing supports CRLF/comments/multiline data and rejects partial frames', () => {
  assert.deepEqual(decodeEvents(': keepalive\r\n\r\ndata: {"value":\r\ndata: 1}\r\n\r\ndata: [DONE]\r\n\r\n').map(event => event.value ?? event.done), [{ value: 1 }, true]);
  assert.throws(() => decodeEvents('data: [DONE]'), /malformed/);
  assert.throws(() => decodeEvents('data: {not json}\n\n'), /malformed/);
  assert.throws(() => decodeEvents('x'.repeat(RESPONSE_BYTES + 1)), /size/);
});

test('Z.ai applies replacements and UTF-16 edits, requires provider completion', () => {
  assert.equal(parseZaiStream(sse([{ data: { content: 'A😀wrong' } }, { data: { edit_index: 3, edit_content: 'right' } }, { data: { delta_content: '!' } }, { data: { phase: 'done' } }])), 'A😀right!');
  assert.equal(parseZaiStream(sse([{ data: { content: 'wrong' } }, { data: { edit_content: 'right' } }, { data: { phase: 'done' } }, '[DONE]'])), 'right');
  for (const raw of [sse([{ data: { delta_content: 'partial' } }, '[DONE]']), sse([{ data: { content: 'A😀' } }, { data: { edit_index: 2, edit_content: 'bad' } }, { data: { phase: 'done' } }]), sse([{ data: { content: 7, phase: 'done' } }]), sse([{ data: { content: 'ok', phase: 'done' } }, { data: { delta_content: 'late' } }])]) assert.throws(() => parseZaiStream(raw));
});

test('Z.ai removes only explicit provider reasoning and preserves answer code', () => {
  const code = '<details><summary>Example</summary>keep me</details>\n```xml\n<tool_call>literal</tool_call>\n```';
  assert.equal(parseZaiStream(sse([{ data: { content: `<details type="reasoning">scratch</details>\n${code}` } }, { data: { phase: 'done' } }])), code);
  assert.equal(parseZaiStream(sse([{ data: { content: code, phase: 'done' } }])), code);
});

test('Z.ai separates verified reasoning wrappers after split deltas, raw edits and full snapshots', () => {
  assert.equal(capturedFromLiveAccount, false);
  for (const events of [editedReasoningGreeting, splitReasoningGreeting, replacedReasoningGreeting]) {
    assert.equal(parseZaiStream(sse([...events, '[DONE]'])), greeting);
  }
  assert.equal(parseZaiStream(sse([{ data: { content: 'Before.<details>Provider thinking</details>After.' } }, { data: { phase: 'done' } }])), 'Before.After.');
  assert.equal(parseZaiStream(sse([{ data: { content: '<details>> A quoted "<details>" tag and `<details>` example.</details>Final answer' } }, { data: { phase: 'done' } }])), 'Final answer');
  const rawPrefix = '<details>> A😀wrong';
  assert.equal(parseZaiStream(sse([{ data: { content: rawPrefix } }, { data: { edit_index: '<details>> A😀'.length, edit_content: 'right</details>Final 😀 answer' } }, { data: { phase: 'done' } }])), 'Final 😀 answer');
});

test('Z.ai reasoning examples never become answers and unknown channels fail safely', () => {
  for (const events of [
    [{ data: { content: '<details>> Only reasoning</details>' } }, { data: { phase: 'done' } }],
    [{ data: { content: '<details type="reasoning">Unclosed reasoning and JSON examples' } }, { data: { phase: 'done' } }],
    [{ data: { content: 'Incomplete answer' } }, '[DONE]'],
  ]) assert.throws(() => parseZaiStream(sse(events)), { code: 'incomplete_response' });
  for (const events of [
    [{ data: { phase: 'thinking', delta_content: 'Not a verified channel' } }],
    [{ data: { phase: 'thinking' } }, { data: { delta_content: 'Inherited unknown phase' } }],
    [{ data: { channel: 'analysis', content: 'Unknown explicit channel' } }],
  ]) assert.throws(() => parseZaiStream(sse([...events, { data: { phase: 'done' } }])), { code: 'unsupported_response_format' });
});

test('Z.ai preserves reasoning-looking Markdown examples and ordinary expandable HTML', () => {
  for (const text of [
    '```html\n<details>Literal example</details>\n```',
    '~~~html\n<details type="reasoning">Literal example</details>\n~~~',
    'Use `<details>body</details>` in your document.',
    'The literal string "<details type=\'reasoning\'>body</details>" belongs in the answer.',
    '{"content":"Literal <details>body</details> HTML","tool_calls":[]}',
    '<details><summary>Example</summary>Keep this body</details>',
    '<details><summary>Example</summary><details>Nested literal body</details></details>',
    '<details class="example">Keep this HTML</details>',
  ]) assert.equal(parseZaiStream(sse([{ data: { content: text } }, { data: { phase: 'done' } }])), text);
});

class FixtureSession extends EventEmitter {
  constructor(body, failure) { super(); this.body = body; this.failure = failure; this.calls = []; }
  async send(name, options) { this.calls.push({ name, options }); if (name === 'Network.getResponseBody') { if (this.failure) throw this.failure; return { body: this.body, base64Encoded: false }; } return {}; }
  async detach() { this.detached = true; }
}
class FixturePage extends EventEmitter {
  constructor(session) { super(); this.session = session; }
  context() { return { newCDPSession: async () => this.session }; }
  async close() { this.closed = true; this.emit('close'); }
}
const emitRequest = (session, siteId, prompt, requestId = 'fixture') => session.emit('Network.requestWillBeSent', { requestId, request: { method: 'POST', url: siteId === 'chatgpt' ? 'https://chatgpt.com/backend-api/conversation' : 'https://chat.z.ai/api/v2/chat/completions', postData: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }) } });
const emitResponse = (session, requestId = 'fixture', headers = {}) => session.emit('Network.responseReceived', { requestId, response: { status: 200, mimeType: 'text/event-stream', headers: { 'Content-Type': 'text/event-stream', ...headers } } });

test('bounded capture ignores unrelated responses and removes all abort/network listeners', async () => {
  const signal = new AbortController().signal;
  const session = new FixtureSession(completeGPT('OK'));
  const page = new FixturePage(session);
  const capture = await captureBrowserResponse(page, 'chatgpt', 'wanted', signal);
  emitRequest(session, 'chatgpt', 'unrelated', 'other'); emitResponse(session, 'other'); session.emit('Network.loadingFinished', { requestId: 'other' });
  emitRequest(session, 'chatgpt', 'wanted'); emitResponse(session); session.emit('Network.dataReceived', { requestId: 'fixture', dataLength: 100 }); session.emit('Network.loadingFinished', { requestId: 'fixture' });
  assert.equal(await capture.promise, 'OK');
  assert.equal(session.calls[0].options.maxResourceBufferSize, RESPONSE_BYTES);
  await capture.dispose();
  assert.equal(session.eventNames().length, 0); assert.equal(page.listenerCount('close'), 0); assert.equal(getEventListeners(signal, 'abort').length, 0); assert.equal(session.detached, true);
});

test('bounded capture aborts over-limit responses and sanitizes driver errors', async () => {
  for (const mode of ['decoded-limit', 'header-limit', 'capture-error']) {
    const session = new FixtureSession(completeGPT('OK'), mode === 'capture-error' ? new Error('private cookie secret') : null);
    const page = new FixturePage(session); const capture = await captureBrowserResponse(page, 'chatgpt', 'wanted');
    emitRequest(session, 'chatgpt', 'wanted'); emitResponse(session, 'fixture', mode === 'header-limit' ? { 'Content-Length': String(RESPONSE_BYTES + 1) } : {});
    if (mode === 'decoded-limit') session.emit('Network.dataReceived', { requestId: 'fixture', dataLength: RESPONSE_BYTES + 1 });
    else if (mode === 'capture-error') session.emit('Network.loadingFinished', { requestId: 'fixture' });
    await assert.rejects(capture.promise, error => error.code === (mode === 'capture-error' ? 'incomplete_response' : 'response_too_large') && !error.message.includes('private cookie'));
    await capture.dispose(); assert.equal(session.eventNames().length, 0);
    if (mode !== 'capture-error') assert.equal(page.closed, true);
  }
});

test('bounded capture cancellation and timeout close only the turn page', async () => {
  const controller = new AbortController(); const session = new FixtureSession(''); const page = new FixturePage(session);
  const capture = await captureBrowserResponse(page, 'chatgpt', 'wanted', controller.signal);
  const reason = new Error('fixture cancellation'); controller.abort(reason);
  await assert.rejects(capture.promise, error => error === reason); await capture.dispose();
  assert.equal(page.closed, true); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const timedPage = new FixturePage(new FixtureSession('')); const timed = await captureBrowserResponse(timedPage, 'zai', 'wanted', undefined, { timeoutMs: 10 });
  await assert.rejects(timed.promise, { code: 'timeout' }); await timed.dispose(); assert.equal(timedPage.closed, true);
});

test('request correlation requires exact origin, completion endpoint, POST and prompt', () => {
  const request = (url, method, content) => ({ url: () => url, method: () => method, postDataJSON: () => ({ messages: [{ author: { role: 'user' }, content: { parts: [content] } }] }) });
  assert.equal(requestMatches(request('https://chatgpt.com/backend-api/f/conversation', 'POST', 'exact'), 'chatgpt', 'exact'), true);
  for (const value of [request('https://example.test/backend-api/conversation', 'POST', 'exact'), request('https://chatgpt.com/backend-api/models', 'POST', 'exact'), request('https://chatgpt.com/backend-api/conversation', 'GET', 'exact'), request('https://chatgpt.com/backend-api/conversation', 'POST', 'different')]) assert.equal(requestMatches(value, 'chatgpt', 'exact'), false);
});

test('browser setup rejects download-only channel before touching profiles', async () => {
  await assert.rejects(openProfile({ siteId: 'chatgpt', dataDir: '.', channel: 'chromium' }), /chrome or msedge/);
});

test('browser setup rejects linked profile folders without launching', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'gravity-browser-profile-'));
  const tempRoot = path.resolve(os.tmpdir());
  assert.equal(path.dirname(path.resolve(folder)), tempRoot);
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const dataDir = path.join(folder, 'private'); const target = path.join(folder, 'unrelated-profile');
  await fs.mkdir(dataDir); await fs.mkdir(target); await fs.symlink(target, path.join(dataDir, 'browsers'), process.platform === 'win32' ? 'junction' : 'dir');
  let launched = false;
  await assert.rejects(openProfile({ siteId: 'chatgpt', dataDir, playwright: { chromium: { launchPersistentContext() { launched = true; } } } }), { code: 'invalid_profile_directory' });
  assert.equal(launched, false);
});

test('isolated installed browser submits only intercepted fixture requests', { timeout: 60000 }, async t => {
  const candidates = process.platform === 'win32' ? [['chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'], ['msedge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']] : [];
  let channel;
  for (const [name, file] of candidates) { if (await fs.access(file).then(() => true, () => false)) { channel = name; break; } }
  if (!channel) { t.skip('No installed Chrome/Edge fixture browser found; no download attempted.'); return; }
  const require = createRequire(new URL('../bridges/multi-web2api/package.json', import.meta.url));
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
  t.after(() => browser.close());
  for (const fixture of [
    { id: 'chatgpt', body: patchGPT(), expected: 'Hello world!' },
    { id: 'zai', body: sse([{ data: { content: 'OK', phase: 'done' } }]), expected: 'OK' },
    { id: 'zai', body: sse([{ data: { delta_content: 'partial' } }, '[DONE]']), error: 'incomplete_response' },
    { id: 'chatgpt', body: completeGPT('unused'), draft: 'saved draft', error: 'draft_present' },
  ]) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let submitted = 0;
    const endpoint = fixture.id === 'chatgpt' ? '/backend-api/conversation' : '/api/v2/chat/completions';
    const origin = fixture.id === 'chatgpt' ? 'https://chatgpt.com' : 'https://chat.z.ai';
    const inputId = fixture.id === 'chatgpt' ? 'prompt-textarea' : 'chat-input';
    const html = `<main><textarea id="${inputId}">${fixture.draft || ''}</textarea><button id="send-message-button" data-testid="send-button" aria-label="Send message">Send</button><div id="result"></div><script>document.querySelector('button').onclick=()=>fetch(${JSON.stringify(endpoint)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:document.querySelector('textarea').value}]})}).then(r=>r.text()).then(()=>document.querySelector('#result').textContent='delivered').catch(()=>{});</script></main>`;
    await context.route('**/*', async route => {
      const request = route.request(); const url = new URL(request.url());
      assert.equal(url.origin, origin, 'fixture must never contact a live or unrelated origin');
      if (request.method() === 'GET' && url.pathname === '/') await route.fulfill({ contentType: 'text/html', body: html });
      else if (request.method() === 'POST' && url.pathname === endpoint) { submitted++; await route.fulfill({ contentType: 'text/event-stream', body: fixture.body }); }
      else await route.abort();
    });
    const page = await context.newPage(); const controller = new AbortController();
    try {
      if (fixture.error) await assert.rejects(runBrowserTurn(page, fixture.id, 'isolated fixture prompt', controller.signal, { timeoutMs: 5000 }), { code: fixture.error });
      else { assert.equal(await runBrowserTurn(page, fixture.id, 'isolated fixture prompt', controller.signal, { timeoutMs: 5000 }), fixture.expected); await page.waitForFunction(() => document.querySelector('#result').textContent === 'delivered'); }
      assert.equal(submitted, fixture.draft ? 0 : 1); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally { await context.close(); }
  }
});
