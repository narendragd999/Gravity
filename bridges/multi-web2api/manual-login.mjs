import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { browserSites, ensureProfileDirectory } from './adapters/browser.mjs';
import { bridgeError } from './adapters/browser-stream.mjs';
import { loginFailure } from './login-events.mjs';

const unavailable = message => bridgeError(message, 503, 'browser_unavailable');

function browserCandidates(channel, env) {
  const product = channel === 'chrome' ? ['Google', 'Chrome', 'Application', 'chrome.exe'] : ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
  return [...new Set([env.ProgramFiles || 'C:\\Program Files', env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', env.LOCALAPPDATA]
    .filter(Boolean).map(root => path.win32.join(root, ...product)))];
}

export async function discoverInstalledBrowsers({ platform = process.platform, env = process.env, stat = fs.stat, channels = ['chrome', 'msedge'] } = {}) {
  const result = [];
  for (const channel of channels.filter(value => ['chrome', 'msedge'].includes(value))) {
    let executable;
    if (platform === 'win32') for (const candidate of browserCandidates(channel, env)) {
      try { if ((await stat(candidate)).isFile()) { executable = candidate; break; } } catch { /* Try the next known installation. */ }
    }
    result.push({ channel, label: channel === 'chrome' ? 'Google Chrome' : 'Microsoft Edge', installed: !!executable, ...(executable ? { executable } : {}) });
  }
  return result;
}

// The browser is opened as an ordinary interactive application for sign-in.
// It receives neither a debugging endpoint nor Playwright launch arguments.
// Its dedicated user-data directory is the only profile the bridge ever uses.
export async function openManualLogin({ siteId, dataDir, channel = 'chrome', platform = process.platform, env = process.env,
  spawnBrowser = spawn, stat = fs.stat, clock = Date.now } = {}) {
  if (!browserSites[siteId]) throw bridgeError('Unknown website.', 400);
  if (!['chrome', 'msedge'].includes(channel)) throw bridgeError('Browser channel must be chrome or msedge.', 400);
  if (platform !== 'win32') throw loginFailure('unsupported_platform', 'opening-browser', siteId);
  const executable = (await discoverInstalledBrowsers({ platform, env, stat, channels: [channel] })).find(browser => browser.channel === channel)?.executable;
  if (!executable) throw loginFailure('browser_missing', 'opening-browser', siteId);
  const profileDirectory = await ensureProfileDirectory({ siteId, dataDir });
  // Chromium uses these locks on some installations. Windows commonly uses a
  // named mutex instead, so an early launcher exit is also rejected below.
  for (const name of ['SingletonLock', 'SingletonSocket']) {
    try { await fs.lstat(path.join(profileDirectory, name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw unavailable('The dedicated bridge browser profile could not be checked. Close its browser windows and retry.'); }
    throw loginFailure('profile_busy', 'opening-browser', siteId);
  }
  let child;
  try {
    child = spawnBrowser(executable, [`--user-data-dir=${profileDirectory}`, '--new-window', browserSites[siteId].url],
      { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
  } catch { throw loginFailure('browser_launch_failed', 'opening-browser', siteId); }
  let resolveOpen, rejectOpen, resolveClose, rejectClose, opened = false, startedAt;
  const opening = new Promise((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
  const waitForClose = new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
  // The CLI can be waiting for the user's Enter while a launch error occurs.
  // Keep the original rejection for its later await without an unhandled one.
  waitForClose.catch(() => {});
  child.once('error', () => {
    const error = loginFailure('browser_launch_failed', 'opening-browser', siteId);
    rejectOpen(error); rejectClose(error);
  });
  child.once('spawn', () => {
    opened = true; startedAt = clock(); child.unref(); resolveOpen();
  });
  child.once('close', (code, signal) => {
    if (!opened || code !== 0 || signal) {
      const error = loginFailure('browser_closed_abnormally', 'releasing-profile', siteId);
      rejectOpen(error); rejectClose(error); return;
    }
    // A running Chrome/Edge profile can reuse its existing browser and return
    // from this launcher immediately. That does not mean the profile is closed.
    // Fail safely; an unusually quick manual close must also be retried.
    if (clock() - startedAt < 1000) {
      rejectClose(loginFailure('browser_closed_early', 'releasing-profile', siteId));
      return;
    }
    resolveClose();
  });
  await opening;
  return { profileDirectory, executable, waitForClose };
}
