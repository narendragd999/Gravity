// Run with Electron. HTTPS is intercepted in a nonpersistent session: no live sites or accounts.
import { app, BrowserWindow, session } from 'electron';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SITES } from '../browser-extension/core.mjs';
import { pageBridge } from '../browser-extension/dom.mjs';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const windows = new Set();
const prompt = 'Reply with the fixture completion and the literal code sample.';
const fixtureCode = 'const sample = "<ready>";\nconsole.log(sample);';
let isolatedSession, checks = 0;
// Fixtures open sequentially; keep Electron alive between their windows.
app.on('window-all-closed', () => {});

function pageMarkup(site) {
  const composer = site.id === 'claude' ? '<div data-testid="chat-input" class="ProseMirror" contenteditable="true"></div>'
    : site.id === 'chatgpt' ? '<div id="prompt-textarea" contenteditable="true"></div>'
      : site.id === 'gemini' ? '<rich-textarea><div contenteditable="true" role="textbox"></div></rich-textarea>'
        : site.id === 'deepseek' ? '<textarea placeholder="Message DeepSeek"></textarea>'
          : '<textarea id="chat-input"></textarea>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Isolated ${site.name} adapter fixture</title><style>body{font:16px sans-serif;padding:20px}textarea,[contenteditable]{display:block;width:700px;min-height:60px;border:1px solid gray}button{display:inline-block;padding:10px}article,model-response,rich-textarea,user-query{display:block;padding:8px}pre{white-space:pre-wrap}</style></head><body><main id="fixture-messages"></main>${composer}<button id="fixture-send" data-testid="send-button" aria-label="${site.id === 'qwen' ? 'Send' : 'Send message'}">Send</button></body></html>`;
}

async function fixture(site, options = {}) {
  const win = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: { session: isolatedSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
  windows.add(win); win.on('closed', () => windows.delete(win));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await win.loadURL(`https://${options.wrongHost ? 'fixture.invalid' : site.host}/fixture?site=${site.id}`);
  await win.webContents.executeJavaScript(`(() => {
    const site = ${JSON.stringify(site)}, options = ${JSON.stringify(options)};
    const input = document.querySelector(site.composer[0]);
    const messages = document.querySelector('#fixture-messages');
    const readInput = () => input.tagName === 'TEXTAREA' ? input.value : input.innerText;
    const setInput = value => { if (input.tagName === 'TEXTAREA') input.value = value; else input.textContent = value; };
    globalThis.fixtureState = { sends: 0, stops: 0, submitted: '', inputs: 0, finished: false };
    input.addEventListener('input', () => globalThis.fixtureState.inputs++);
    const addUser = text => {
      const element = document.createElement(site.id === 'gemini' ? 'user-query' : 'div');
      element.setAttribute('data-testid', 'user-message'); element.setAttribute('data-message-author-role', 'user'); element.setAttribute('data-role', 'user');
      element.textContent = text; messages.append(element); return element;
    };
    const addAssistant = text => {
      const shell = document.createElement(site.id === 'gemini' ? 'model-response' : 'article');
      shell.setAttribute('data-testid', 'assistant-message'); shell.setAttribute('data-message-author-role', 'assistant'); shell.setAttribute('data-role', 'assistant');
      const content = document.createElement('div'); content.className = 'model-response-text';
      const paragraph = document.createElement('p'); paragraph.textContent = text; content.append(paragraph); shell.append(content); messages.append(shell);
      return { shell, content, paragraph };
    };
    if (options.history) addAssistant('Existing private conversation must stay untouched.');
    if (options.userHistory) addUser('Existing user turn must stay untouched.');
    if (options.draft) setInput('Preserve this existing draft.');
    if (options.password) { const secret = document.createElement('input'); secret.id = 'chat-input'; secret.type = 'password'; input.replaceWith(secret); }
    if (options.challenge) document.title = 'Verify you are human';
    if (options.noComposer) input.style.display = 'none';
    if (options.noSend) {
      document.querySelector('#fixture-send').disabled = true;
      input.addEventListener('keydown', event => { if (event.key === 'Enter') globalThis.fixtureState.sends++; });
    }
    document.querySelector('#fixture-send').addEventListener('click', () => {
      globalThis.fixtureState.sends++; globalThis.fixtureState.submitted = readInput();
      if (options.noSubmit) return;
      const submitted = readInput(); setInput(''); input.dispatchEvent(new Event('input', { bubbles: true })); addUser(submitted);
      const stop = document.createElement('button'); stop.id = 'fixture-stop'; stop.setAttribute('aria-label', 'Stop generating'); stop.setAttribute('data-testid', 'stop-button'); stop.textContent = 'Stop';
      stop.addEventListener('click', () => { globalThis.fixtureState.stops++; stop.remove(); }); document.body.append(stop);
      if (options.pending) return;
      const assistant = addAssistant('Partial fixture text');
      setTimeout(() => {
        assistant.paragraph.textContent = 'READY: ' + site.id;
        const pre = document.createElement('pre'), code = document.createElement('code'); code.textContent = ${JSON.stringify(fixtureCode)}; pre.append(code); assistant.content.append(pre);
      }, 250);
      setTimeout(() => {
        stop.remove(); globalThis.fixtureState.finished = true;
        const copy = document.createElement('button'); copy.setAttribute('aria-label', site.id === 'gemini' ? 'Copy response' : 'Copy'); copy.setAttribute('data-testid', 'copy-turn-action-button'); copy.textContent = 'DO NOT CAPTURE BUTTON TEXT'; assistant.shell.append(copy);
      }, 650);
    });
  })()`);
  return win;
}

const invoke = (win, action, site, payload = {}) => win.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${pageBridge.toString()})(${JSON.stringify(action)},${JSON.stringify(site)},${JSON.stringify(payload)})` }]);
const state = win => win.webContents.executeJavaScript('globalThis.fixtureState');
const close = win => { if (!win.isDestroyed()) win.destroy(); };
async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(25); }
  assert.fail(label);
}

async function run() {
  await app.whenReady();
  isolatedSession = session.fromPartition(`browser-dom-fixture-${randomUUID()}`);
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolatedSession.setPermissionCheckHandler(() => false);
  await isolatedSession.protocol.handle('https', request => {
    const url = new URL(request.url), site = SITES.find(value => value.id === url.searchParams.get('site'));
    return new Response(site ? pageMarkup(site) : 'No fixture at this URL', { status: site ? 200 : 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  });
  try {
    for (const site of SITES) {
      const win = await fixture(site);
      try {
        const probe = await invoke(win, 'probe', site); assert.equal(probe.connected, true, site.id); assert.equal(probe.busy, false);
        const answer = await invoke(win, 'run', site, { id: `success-${site.id}`, prompt });
        assert.match(answer.text, new RegExp(`READY: ${site.id}`));
        assert.ok(answer.text.includes(`\`\`\`\n${fixtureCode}\n\`\`\``), `${site.id}: literal code is preserved`);
        assert.doesNotMatch(answer.text, /DO NOT CAPTURE|Partial fixture text/);
        const final = await state(win); assert.equal(final.sends, 1); assert.equal(final.submitted, prompt); assert.equal(final.finished, true); assert.ok(final.inputs > 0);
        checks++; console.log(`PASS: ${site.id} real DOM input, new user/assistant turns, completion, and code extraction`);
      } finally { close(win); }
    }

    const site = SITES[0];
    for (const [option, expected] of [['wrongHost', /no longer on the allowed/], ['history', /existing conversation/], ['userHistory', /existing conversation/], ['draft', /existing draft/], ['challenge', /requires a browser verification/]]) {
      const win = await fixture(site, { [option]: true });
      try {
        await assert.rejects(invoke(win, 'run', site, { id: `refusal-${option}`, prompt }), expected);
        assert.equal((await state(win)).sends, 0);
        if (option === 'draft') assert.equal(await win.webContents.executeJavaScript('document.querySelector("[contenteditable]").innerText'), 'Preserve this existing draft.');
        if (option === 'history') assert.match(await win.webContents.executeJavaScript('document.querySelector("#fixture-messages").textContent'), /Existing private conversation/);
        checks++; console.log(`PASS: ${option} refused before submitting a prompt`);
      } finally { close(win); }
    }

    const password = await fixture(SITES.find(site => site.id === 'qwen'), { password: true });
    try { assert.equal((await invoke(password, 'probe', SITES.find(site => site.id === 'qwen'))).connected, false); assert.equal((await state(password)).sends, 0); checks++; console.log('PASS: password inputs are never treated as composers'); } finally { close(password); }

    const pending = await fixture(site, { pending: true });
    try {
      const outcome = invoke(pending, 'run', site, { id: 'cancel-fixture', prompt }).then(value => ({ value }), error => ({ error }));
      await until(async () => (await state(pending)).sends === 1, 'Pending fixture submits exactly once');
      const cancelled = await invoke(pending, 'cancel', site, { id: 'cancel-fixture' }); assert.equal(cancelled.cancelled, true);
      assert.match((await outcome).error?.message || '', /cancelled this browser request/);
      const final = await state(pending); assert.equal(final.sends, 1); assert.equal(final.stops, 1);
      assert.equal((await invoke(pending, 'cancel', site, { id: 'cancel-fixture' })).cancelled, false, 'Completed cancellation leaves no stale task');
      checks++; console.log('PASS: cancellation stops only the active task and returns no partial success');
    } finally { close(pending); }
    const timed = await fixture(site, { pending: true });
    try {
      await assert.rejects(invoke(timed, 'run', site, { id: 'deadline-fixture', prompt, timeoutMs: 1200 }), /did not produce a verifiably completed/);
      const final = await state(timed); assert.equal(final.sends, 1); assert.equal(final.stops, 1);
      assert.equal((await invoke(timed, 'cancel', site, { id: 'deadline-fixture' })).cancelled, false);
      checks++; console.log('PASS: remaining generation budget stops the owned task without returning partial success');
    } finally { close(timed); }
    for (const [name, options, payload, edited] of [
      ['late injection', {}, { deadlineAt: Date.now() - 1000 }, false],
      ['composer deadline', { noComposer: true }, { timeoutMs: 150 }, false],
      ['send deadline', { noSend: true }, { timeoutMs: 600 }, true]
    ]) {
      const expired = await fixture(site, options);
      try {
        await assert.rejects(invoke(expired, 'run', site, { id: `expired-${name}`, prompt, ...payload }), /expired before submission.*No prompt was submitted/);
        const final = await state(expired); assert.equal(final.sends, 0, name); assert.equal(final.inputs > 0, edited, name);
        assert.equal((await invoke(expired, 'cancel', site, { id: `expired-${name}` })).cancelled, false);
        checks++; console.log(`PASS: ${name} refuses to submit after the request expires`);
      } finally { close(expired); }
    }
    console.log(`PASS: ${checks} isolated Electron DOM checks. Synthetic fixtures only; no live website compatibility or account access verified.`);
  } finally {
    for (const win of windows) close(win);
    await isolatedSession.protocol.unhandle('https');
  }
  app.quit();
}

run().catch(error => { console.error(error); for (const win of windows) close(win); app.exit(1); });
