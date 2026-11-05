import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openManualLogin, discoverInstalledBrowsers } from '../bridges/multi-web2api/manual-login.mjs';
import { normalizeLoginEvent, makeLoginReporter, LOGIN_EVENT_PREFIX } from '../bridges/multi-web2api/login-events.mjs';
import { openProfile } from '../bridges/multi-web2api/adapters/browser.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gravity-manual-login-'));
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const child = new EventEmitter(); child.unref = () => { child.unreferenced = true; };
  const launches = [], checked = []; let time = 1000;
  const options = { siteId: 'zai', dataDir: directory, platform: 'win32', env: { ProgramFiles: 'C:\\Installed Browser', LOCALAPPDATA: 'C:\\Local AppData' },
    clock: () => time,
    stat: async filename => { checked.push(filename); return { isFile: () => true }; },
    spawnBrowser: (executable, args, launchOptions) => { launches.push({ executable, args, launchOptions }); queueMicrotask(() => child.emit('spawn')); return child; } };
  return { directory, child, launches, checked, options, advance: milliseconds => { time += milliseconds; } };
}

test('manual sign-in launches an isolated normal browser and waits for its close', async t => {
  const f = await fixture(t); const result = await openManualLogin(f.options);
  assert.equal(result.profileDirectory, path.join(f.directory, 'browsers', 'zai'));
  assert.equal(result.executable, 'C:\\Installed Browser\\Google\\Chrome\\Application\\chrome.exe');
  assert.deepEqual(f.launches[0].args, [`--user-data-dir=${result.profileDirectory}`, '--new-window', 'https://chat.z.ai/']);
  assert.deepEqual(f.launches[0].launchOptions, { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
  assert.equal(f.child.unreferenced, true);
  let closed = false; result.waitForClose.then(() => { closed = true; }); await Promise.resolve(); assert.equal(closed, false);
  f.advance(3000); f.child.emit('close', 0, null); await result.waitForClose; assert.equal(closed, true);
});

test('manual login tries standard Edge locations and rejects missing/unsupported browsers before profile creation', async t => {
  const f = await fixture(t);
  let attempts = 0;
  const result = await openManualLogin({ ...f.options, channel: 'msedge', stat: async filename => {
    f.checked.push(filename); if (++attempts < 3) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return { isFile: () => true };
  } });
  assert.equal(result.executable, 'C:\\Local AppData\\Microsoft\\Edge\\Application\\msedge.exe');
  assert.equal(attempts, 3); f.advance(1000); f.child.emit('close', 0); await result.waitForClose;
  const missingDir = path.join(f.directory, 'missing');
  await assert.rejects(openManualLogin({ ...f.options, dataDir: missingDir, stat: async () => { throw new Error('PRIVATE_SECRET'); } }), error => error.code === 'browser_missing' && !error.message.includes('PRIVATE_SECRET'));
  await assert.rejects(openManualLogin({ ...f.options, dataDir: missingDir, platform: 'linux' }), { code: 'unsupported_platform' });
  await assert.rejects(openManualLogin({ ...f.options, dataDir: missingDir, channel: 'chromium' }), /chrome or msedge/);
  assert.equal(await fs.stat(missingDir).then(() => true, () => false), false);
});

test('manual login rejects a linked private profile and an existing profile lock without launching', async t => {
  const f = await fixture(t); const target = path.join(f.directory, 'other'); const dataDir = path.join(f.directory, 'private');
  await fs.mkdir(target); await fs.mkdir(dataDir); await fs.symlink(target, path.join(dataDir, 'browsers'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(openManualLogin({ ...f.options, dataDir }), { code: 'invalid_profile_directory' });
  assert.equal(f.launches.length, 0);
  const profile = path.join(f.directory, 'browsers', 'zai'); await fs.mkdir(profile, { recursive: true }); await fs.writeFile(path.join(profile, 'SingletonLock'), 'fixture');
  await assert.rejects(openManualLogin(f.options), { code: 'profile_busy' }); assert.equal(f.launches.length, 0);
});

test('manual login treats reused launcher exits and abnormal closes as failed setup', async t => {
  for (const mode of ['fast', 'nonzero', 'signal', 'error']) {
    const f = await fixture(t); const result = await openManualLogin(f.options);
    if (mode !== 'fast') f.advance(3000);
    if (mode === 'error') f.child.emit('error', new Error('PRIVATE_SECRET'));
    else f.child.emit('close', mode === 'nonzero' ? 1 : 0, mode === 'signal' ? 'SIGTERM' : null);
    await assert.rejects(result.waitForClose, error => error.code === (mode === 'fast' ? 'browser_closed_early' : mode === 'error' ? 'browser_launch_failed' : 'browser_closed_abnormally') && !error.message.includes('PRIVATE_SECRET'));
  }
});

test('manual login sanitizes browser creation errors and handles asynchronous failure before spawn', async t => {
  const f = await fixture(t);
  await assert.rejects(openManualLogin({ ...f.options, spawnBrowser: () => { throw new Error('PRIVATE_SECRET'); } }), error => error.code === 'browser_launch_failed' && !error.message.includes('PRIVATE_SECRET'));
  await assert.rejects(openManualLogin({ ...f.options, spawnBrowser: () => {
    queueMicrotask(() => f.child.emit('error', new Error('PRIVATE_SECRET'))); return f.child;
  } }), error => error.code === 'browser_launch_failed' && !error.message.includes('PRIVATE_SECRET'));
});

test('browser discovery reports supported installations without launching or reading profiles', async t => {
  const f = await fixture(t);
  const result = await discoverInstalledBrowsers({ platform: 'win32', env: f.options.env, stat: async filename => {
    if (filename.endsWith('msedge.exe')) throw new Error('missing'); return { isFile: () => true };
  } });
  assert.equal(result.find(item => item.channel === 'chrome').installed, true);
  assert.equal(result.find(item => item.channel === 'msedge').installed, false);
  assert.deepEqual(await fs.readdir(f.directory), []); assert.equal(f.launches.length, 0);
});

test('structured events retain only approved diagnostic fields', () => {
  const events = [];
  const reporter = makeLoginReporter('chatgpt', { write: line => events.push(line), browserChannel: 'chrome', now: () => 100 });
  reporter('checking-session', 'error', 'draft_present', { url: 'https://private.test/account', token: 'PRIVATE_SECRET', message: 'PRIVATE_MESSAGE' });
  const event = normalizeLoginEvent(JSON.parse(events[0].slice(LOGIN_EVENT_PREFIX.length)));
  assert.equal(event.code, 'draft_present'); assert.equal(event.stage, 'checking-session');
  assert.ok(!events[0].includes('PRIVATE')); assert.ok(!events[0].includes('private.test'));
  assert.equal(normalizeLoginEvent({ ...event, code: 'arbitrary_secret', type: 'error' }), null);
  assert.equal(normalizeLoginEvent({ ...event, stage: 'arbitrary_secret' }), null);
});

test('bridge runtime enables Chromium sandbox without changing automation arguments', async t => {
  const f = await fixture(t); let launch;
  const context = await openProfile({ siteId: 'chatgpt', dataDir: f.directory, playwright: { chromium: { launchPersistentContext: async (directory, options) => { launch = { directory, options }; return 'fixture context'; } } } });
  assert.equal(context, 'fixture context'); assert.equal(launch.directory, path.join(f.directory, 'browsers', 'chatgpt'));
  assert.equal(launch.options.chromiumSandbox, true); assert.equal(launch.options.acceptDownloads, false);
  assert.equal(launch.options.args, undefined); assert.equal(launch.options.ignoreDefaultArgs, undefined);
});
