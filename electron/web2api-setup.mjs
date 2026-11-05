import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { discoverModels } from './providers.mjs';
import { LOGIN_EVENT_PREFIX, LOGIN_ERRORS, LOGIN_STAGES, loginFailure, normalizeLoginEvent } from '../bridges/multi-web2api/login-events.mjs';

const SITES = Object.freeze([
  { id: 'chatgpt', label: 'ChatGPT', model: 'chatgpt-web' },
  { id: 'zai', label: 'Z.ai', model: 'zai-web' },
  { id: 'deepseek', label: 'DeepSeek', model: 'deepseek-web' },
  { id: 'qwen', label: 'Qwen', model: 'qwen-web' },
]);
const MAX_OUTPUT = 1024 * 1024;
const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const samePath = (left, right) => typeof left === 'string' && typeof right === 'string' && canonical(left) === canonical(right);
const sameUrl = (left, right) => {
  try { return new URL(left).toString().replace(/\/$/, '') === new URL(right).toString().replace(/\/$/, ''); }
  catch { return false; }
};
const cancelled = () => new Error('Setup cancelled. Your saved website sign-ins are kept.');
const unavailable = 'The built-in website service is unavailable. Reopen Gravity or reinstall the latest app, then try again.';

/** Owns only setup helpers; bridge process ownership remains in ManagedBridges. */
export class Web2ApiSetup {
  constructor({ store, bridges, companionRoots = [], previousDataDirs = [], changed, onChange = changed || (() => {}),
    spawnProcess = spawn, discover = discoverModels, readFile = fs.readFile, lstat = fs.lstat,
    realpath = fs.realpath, helperTimeoutMs = 20000, loginTimeoutMs = 600000, helperCloseTimeoutMs = 3500,
    fetchImpl = globalThis.fetch, appVersion = 'unknown' } = {}) {
    this.store = store; this.bridges = bridges; this.roots = companionRoots;
    this.previousDataDirs = Array.isArray(previousDataDirs)
      ? previousDataDirs.filter(value => typeof value === 'string' && path.isAbsolute(value)).map(value => path.resolve(value)) : [];
    this.onChange = onChange; this.spawnProcess = spawnProcess; this.discover = discover;
    this.readFile = readFile; this.lstat = lstat; this.realpath = realpath;
    this.helperTimeoutMs = helperTimeoutMs; this.loginTimeoutMs = loginTimeoutMs; this.helperCloseTimeoutMs = helperCloseTimeoutMs;
    this.fetch = fetchImpl; this.appVersion = /^\d+(?:\.\d+){1,3}$/.test(appVersion) ? appVersion : 'unknown'; this.events = [];
    this.state = { available: false, busy: false, phase: 'idle', message: 'Checking website setup.', models: [], browsers: [], browserChannel: 'chrome',
      sites: SITES.map(site => ({ id: site.id, label: site.label, enabled: false })) };
    this.operation = null; this.child = null; this.companion = null; this.closing = false; this.refreshSequence = 0;
    this.browserProbe = null; this.browserProbeController = null;
  }

  status() {
    const result = structuredClone(this.state);
    const runtime = this.bridges.status().find(item => item.id === result.bridgeId);
    if (!result.busy && runtime?.state === 'ready' && result.defaultModel && result.models.includes(result.defaultModel)
      && !['error', 'cancelled', 'waiting-idle'].includes(result.phase)) {
      result.phase = 'ready'; result.message = 'Connected. Gravity will start this service when it opens.';
      result.error = undefined;
    } else if (!result.busy && runtime?.state === 'error') {
      result.phase = 'error'; result.error = this.safeError(new Error(runtime.error || 'The website service needs attention. Click Connect to try again.'));
      result.message = result.error;
    } else if (!result.busy && result.phase === 'ready') {
      result.phase = 'idle'; result.message = 'Your website setup is saved. Click Connect to start it.';
    }
    return result;
  }

  changed(patch = {}) {
    Object.assign(this.state, patch);
    try { this.onChange(); } catch { /* Window shutdown does not interrupt cleanup. */ }
  }

  diagnostics() {
    const runtime = this.bridges.status().find(item => item.id === this.state.bridgeId);
    return { version: 1, appVersion: this.appVersion, timestamp: new Date().toISOString(),
      phase: this.state.phase, stage: this.state.stage, errorCode: this.state.errorCode,
      browserChannel: this.state.browserChannel, runtimeVersion: this.runtimeVersion,
      browserVersion: this.browserVersion,
      service: { state: runtime?.state || 'stopped', owned: !!this.bridges.entries?.get(this.state.bridgeId)?.child },
      events: this.events.map(event => ({ ...event })) };
  }

  async listBrowsers() {
    // A remounted settings page shares the previous read-only browser query.
    // Otherwise it can enable Connect while that query still owns the helper.
    if (this.browserProbe) return this.browserProbe;
    if (this.operation || this.child || this.closing) return this.status();
    const controller = new AbortController(); this.browserProbeController = controller;
    const probe = (async () => {
      await this.refresh(); controller.signal.throwIfAborted();
      if (!this.companion || this.operation || this.child || this.closing) return this.status();
      const raw = await this.helper(['browsers', '--json'], { signal: controller.signal });
      controller.signal.throwIfAborted();
      let result; try { result = JSON.parse(raw); } catch { throw new Error('Installed browsers could not be checked. Try again.'); }
      const browsers = ['chrome', 'msedge'].map(channel => {
        const item = result.browsers?.find(value => value.channel === channel);
        return { channel, label: channel === 'chrome' ? 'Google Chrome' : 'Microsoft Edge', installed: item?.installed === true };
      });
      this.changed({ browsers, ...(['chrome', 'msedge'].includes(result.browserChannel) ? { browserChannel: result.browserChannel } : {}) });
      if (/^v?\d+(?:\.\d+){1,4}$/.test(result.runtimeVersion || '')) this.runtimeVersion = result.runtimeVersion;
      return this.status();
    })();
    this.browserProbe = probe;
    try { return await probe; }
    finally {
      if (this.browserProbe === probe) this.browserProbe = null;
      if (this.browserProbeController === controller) this.browserProbeController = null;
    }
  }

  async waitForBrowserProbe(probe, signal) {
    let timer, abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => reject(signal.reason || cancelled());
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        const error = new Error('The browser check is still closing. Wait a moment and try Connect again.');
        this.browserProbeController?.abort(error); reject(error);
      }, this.helperTimeoutMs + this.helperCloseTimeoutMs);
    });
    try { await Promise.race([probe, interrupted]); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }

  async setBrowser(channel) {
    if (!['chrome', 'msedge'].includes(channel)) throw new Error('Choose Chrome or Edge.');
    if (this.operation || this.child) throw new Error('Finish or cancel account setup before changing browsers.');
    await this.listBrowsers();
    if (this.closing) throw new Error('Gravity is shutting down.');
    if (this.operation || this.child) throw new Error('Finish or cancel account setup before changing browsers.');
    if (!this.state.browsers.find(browser => browser.channel === channel)?.installed) throw loginFailure('browser_missing', 'opening-browser', this.state.siteId);
    await this.helper(['browser', channel]);
    await this.refresh(); this.changed({ browserChannel: channel });
    return this.status();
  }

  openAccount(siteId) { return this.connect(siteId, { forceLogin: true }); }

  recordLoginEvent(event) {
    this.events.push(event); this.events = this.events.slice(-24);
    if (event.runtimeVersion) this.runtimeVersion = event.runtimeVersion;
    if (event.browserVersion) this.browserVersion = event.browserVersion;
    const verifying = !['opening-browser', 'waiting-for-sign-in', 'waiting-for-browser-close'].includes(event.stage);
    const failure = event.type === 'error' ? loginFailure(event.code, event.stage, event.siteId) : null;
    this.changed({ stage: event.stage, ...(event.browserChannel ? { browserChannel: event.browserChannel } : {}),
      ...(failure ? { errorCode: failure.code, recoveryAction: failure.recoveryAction, error: failure.message, message: failure.message }
        : { phase: verifying ? 'verifying' : 'login', error: undefined, errorCode: undefined, recoveryAction: undefined,
          message: event.stage === 'waiting-for-security-check' ? 'Complete the security check in the open verification browser. Keep it open; Gravity continues automatically.' : verifying ? 'Checking the saved account session.' : 'Sign in, open a new empty chat, and close the separate account browser.' }) });
  }

  step(stage, phase, message) {
    this.changed({ stage, phase, message });
    const event = normalizeLoginEvent({ version: 1, type: 'progress', siteId: this.state.siteId, stage, timestamp: Date.now(), browserChannel: this.state.browserChannel });
    if (event) { this.events.push(event); this.events = this.events.slice(-24); }
  }

  async regular(filename, directory = false) {
    const info = await this.lstat(filename);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error('Invalid companion path.');
    if (!samePath(await this.realpath(filename), filename)) throw new Error('Linked companion paths are unsupported.');
    return info;
  }

  async locate() {
    for (const location of this.roots) {
      const root = typeof location === 'string' ? location : location?.root;
      if (typeof root !== 'string' || !path.isAbsolute(root)) continue;
      const candidate = { root: path.resolve(root), executable: path.join(root, 'runtime', 'node.exe'),
        cli: path.join(root, 'bridge', 'cli.mjs'), cwd: path.join(root, 'bridge'), dataDir: location?.dataDir || path.join(root, '.data') };
      if (typeof candidate.dataDir !== 'string' || !path.isAbsolute(candidate.dataDir)) continue;
      try {
        await this.regular(candidate.root, true); await this.regular(path.join(root, 'runtime'), true);
        await this.regular(candidate.cwd, true); await this.regular(candidate.executable); await this.regular(candidate.cli);
        return candidate;
      } catch { /* Try another companion location provided by the application. */ }
    }
    throw new Error(unavailable);
  }

  matchingProfile(companion, providerId) {
    return this.store.data.bridgeProfiles.find(profile => profile.providerId === providerId
      && profile.args?.length === 4 && profile.args[1] === 'start' && profile.args[2] === '--data-dir'
      && (samePath(profile.args[3], companion.dataDir) || (profile.launchMode === 'managed'
        && this.previousDataDirs.some(directory => samePath(profile.args[3], directory)))) && typeof profile.cwd === 'string'
      && samePath(profile.args[0], path.join(profile.cwd, 'cli.mjs'))
      && samePath(profile.executable, path.join(path.dirname(profile.cwd), 'runtime', 'node.exe'))
      && path.basename(profile.cwd) === 'bridge');
  }

  desiredProfile(preset, providerId, current) {
    return { ...(current ? { id: current.id } : {}), name: current?.name || 'Gravity Web2API', providerId,
      launchMode: 'managed', executable: preset.bridge.executable, args: preset.bridge.args, cwd: preset.bridge.cwd,
      ...(current ? {} : { env: {} }), healthUrl: preset.bridge.healthUrl, startupTimeoutMs: current?.startupTimeoutMs || 30000 };
  }

  profileNeedsUpdate(profile, companion) {
    return profile.launchMode !== 'managed' || !samePath(profile.executable, companion.executable)
      || !samePath(profile.cwd, companion.cwd) || !samePath(profile.args[0], companion.cli)
      || !samePath(profile.args[3], companion.dataDir);
  }

  async refresh({ owner, companion: pinned } = {}) {
    if (this.operation && owner !== this.operation) return this.status();
    const sequence = ++this.refreshSequence;
    const current = () => sequence === this.refreshSequence && (!this.operation || owner === this.operation);
    try {
      const companion = pinned || await this.locate();
      let config;
      try {
        await this.regular(companion.dataDir, true);
        const filename = path.join(companion.dataDir, 'config.json'), info = await this.regular(filename);
        if (info.size > MAX_OUTPUT) throw new Error('Saved config is too large.');
        config = JSON.parse(await this.readFile(filename, 'utf8'));
        if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || !config.providers
          || SITES.some(site => typeof config.providers[site.id]?.enabled !== 'boolean')) throw new Error('Invalid saved config.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Saved website setup could not be read. Restore its private configuration and try again.');
      }
      const baseUrl = config ? `http://127.0.0.1:${config.port}/v1` : undefined;
      const provider = baseUrl && this.store.data.providers.find(item => item.type === 'openai' && sameUrl(item.baseUrl, baseUrl) && item.managedBy !== 'browser-connector');
      const profile = provider && this.matchingProfile(companion, provider.id);
      const models = (provider?.models || []).filter(model => SITES.some(site => config?.providers[site.id]?.enabled
        && (model === site.model || (site.id === 'deepseek' && model === 'deepseek-web-thinking'))));
      const defaultModel = models.includes(provider?.defaultModel) ? provider.defaultModel : models[0];
      const defaultSite = SITES.find(site => defaultModel === site.model || (site.id === 'deepseek' && defaultModel === 'deepseek-web-thinking'));
      if (!current()) return this.status();
      this.companion = companion; this.configuredPort = config?.port; this.privateConfig = config ? structuredClone(config) : undefined;
      this.changed({ available: true, sites: SITES.map(site => ({ id: site.id, label: site.label, enabled: !!config?.providers[site.id]?.enabled })),
        browserChannel: config?.browserChannel || this.state.browserChannel,
        providerId: provider?.id, defaultModel, bridgeId: profile?.id, models, error: undefined,
        ...(!this.state.busy ? { siteId: defaultSite?.id,
          ...(['idle', 'error'].includes(this.state.phase) ? { phase: 'idle', message: 'Choose a website. Gravity handles the connection and startup.' } : {}) } : {}) });
    } catch (error) {
      if (!current()) return this.status();
      this.companion = null;
      this.configuredPort = undefined;
      this.changed({ available: false, providerId: undefined, bridgeId: undefined, defaultModel: undefined, siteId: undefined,
        models: [], sites: SITES.map(site => ({ id: site.id, label: site.label, enabled: false })),
        error: error.message, ...(!this.state.busy ? { phase: 'error', message: error.message } : {}) });
    }
    return this.status();
  }

  async prepareStartup() {
    if (this.operation || this.child) return this.status();
    await this.refresh();
    if (this.operation || this.child || !this.companion || !this.configuredPort) return this.status();
    const companion = this.companion;
    const provider = this.store.data.providers.find(item => item.type === 'openai'
      && sameUrl(item.baseUrl, `http://127.0.0.1:${this.configuredPort}/v1`) && item.managedBy !== 'browser-connector');
    const profile = provider && this.matchingProfile(companion, provider.id);
    if (!profile || profile.launchMode !== 'managed' || !this.profileNeedsUpdate(profile, companion)) return this.status();
    this.ensureNoConversation(provider.id);
    if (this.bridges.status().some(item => item.id === profile.id && (item.running || item.starting))) {
      throw new Error('Stop the saved website bridge before updating its application paths.');
    }
    const preset = await this.preset(undefined, companion);
    this.ensureNoConversation(provider.id);
    if (this.bridges.status().some(item => item.id === profile.id && (item.running || item.starting))) {
      throw new Error('Stop the saved website bridge before updating its application paths.');
    }
    this.store.saveBridgeProfile(this.desiredProfile(preset, provider.id, profile));
    this.changed({ providerId: provider.id, bridgeId: profile.id });
    return this.status();
  }

  helper(args, { signal, login = false, companion = this.companion, stdinPayload } = {}) {
    if (this.child) return Promise.reject(new Error('The previous website helper is still closing. Wait a moment before trying again.'));
    return new Promise((resolve, reject) => {
      let child, output = '', size = 0, finished = false, timer, loginLines = '', lastLoginError;
      const finish = (error, value) => {
        if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      const stop = () => {
        try { child?.stdin?.write('cancel\n'); child?.stdin?.end(); } catch { /* It may already have closed. */ }
        const killTimer = setTimeout(() => { try { child?.kill(); } catch { /* It may already have closed. */ } }, 1500);
        killTimer.unref?.(); child?.once('close', () => clearTimeout(killTimer));
      };
      const abort = () => { finish(signal.reason || cancelled()); stop(); };
      if (signal?.aborted) { finish(signal.reason || cancelled()); return; }
      try {
        child = this.spawnProcess(companion.executable, [companion.cli, ...args, '--data-dir', companion.dataDir],
          { cwd: companion.cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch { finish(new Error(unavailable)); return; }
      this.child = child;
      this.helperExit = new Promise(resolveExit => child.once('close', () => {
        if (this.child === child) this.child = null;
        resolveExit();
        if (!this.operation && this.state.busy) this.changed({ busy: false });
      }));
      const consume = (chunk, stdout) => {
        if (finished) return;
        size += chunk.length;
        if (size > MAX_OUTPUT) { stop(); finish(new Error('The website helper returned too much output. Try setup again.')); return; }
        const text = chunk.toString();
        if (!login && stdout) output += text;
        if (login && stdout) {
          loginLines += text;
          let boundary;
          while ((boundary = loginLines.indexOf('\n')) >= 0) {
            const line = loginLines.slice(0, boundary).replace(/\r$/, ''); loginLines = loginLines.slice(boundary + 1);
            if (!line.startsWith(LOGIN_EVENT_PREFIX)) continue;
            let event; try { event = normalizeLoginEvent(JSON.parse(line.slice(LOGIN_EVENT_PREFIX.length))); } catch { /* Ignore malformed private helper output. */ }
            if (event && event.siteId === this.state.siteId) {
              this.recordLoginEvent(event);
              if (event.type === 'error') lastLoginError = loginFailure(event.code, event.stage, event.siteId);
            }
          }
          if (loginLines.length > 8192) loginLines = '';
        }
        // Raw website/helper output can contain account details. It is never a renderer log.
      };
      child.stdout?.on('data', chunk => consume(chunk, true)); child.stderr?.on('data', chunk => consume(chunk, false));
      child.once('error', () => finish(new Error(unavailable)));
      child.once('close', code => {
        if (code === 0) finish(null, output);
        else if (lastLoginError) finish(lastLoginError);
        else finish(new Error(login
          ? 'Website sign-in did not finish. Try Connect again, complete its checks, and open a new empty chat.'
          : 'The website helper could not read its saved setup. Restore its configuration and try again.'));
      });
      timer = setTimeout(() => { finish(login ? loginFailure('browser_close_timeout', this.state.stage || 'waiting-for-browser-close', this.state.siteId)
        : new Error('The website helper timed out. Try again.')); stop(); }, login ? this.loginTimeoutMs : this.helperTimeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (stdinPayload !== undefined) { child.stdin?.end(stdinPayload); }
    });
  }

  async preset(signal, companion = this.companion) {
    const raw = await this.helper(['info', '--json'], { signal, companion });
    let value; try { value = JSON.parse(raw); } catch { throw new Error('The companion returned invalid setup information. Restore its files and try again.'); }
    const { provider, bridge } = value || {};
    let url; try { url = new URL(provider?.baseUrl); } catch { /* Validation below reports a fixed message. */ }
    if (!provider || provider.type !== 'openai' || !url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, '') !== '/v1'
      || !url.port || !/^[A-Za-z0-9_-]{24,128}$/.test(provider.apiKey || '')
      || !bridge || !samePath(bridge.executable, companion.executable) || !samePath(bridge.cwd, companion.cwd)
      || bridge.args?.length !== 4 || !samePath(bridge.args[0], companion.cli) || bridge.args[1] !== 'start'
      || bridge.args[2] !== '--data-dir' || !samePath(bridge.args[3], companion.dataDir)
      || bridge.healthUrl !== `${url.origin}/health`) throw new Error('The companion returned unexpected connection information. Restore its files and try again.');
    return { provider: { ...provider, baseUrl: `${url.origin}/v1` }, bridge };
  }

  ensureNoConversation(providerId) {
    if (providerId && this.store.data.conversations.some(conversation => conversation.providerId === providerId && conversation.status === 'running')) {
      throw new Error('Stop chats using this website connection before changing its setup.');
    }
  }

  ensureNoAccountConversation(providerId, siteId) {
    if (providerId && this.store.data.conversations.some(item => item.providerId === providerId && item.status === 'running' && String(item.model || '').startsWith(`${siteId}-web`))) {
      throw new Error('Wait for this account’s running chat before signing in again.');
    }
  }

  async serviceRequest(provider, pathname, { method = 'GET', signal } = {}) {
    const base = new URL(provider.baseUrl);
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('The website service must use its local connection.');
    const response = await this.fetch(`${base.origin}${pathname}`, { method, headers: { Authorization: `Bearer ${provider.apiKey}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000), redirect: 'error' });
    let body = '', bytes = 0;
    for await (const chunk of response.body || []) { bytes += chunk.length; if (bytes > 65536) throw new Error('The website status was too large.'); body += Buffer.from(chunk).toString(); }
    if (!response.ok) { const error = new Error(response.status === 409 ? 'Wait for this account’s running request before signing in again.' : 'The owned website service could not release its account browser.'); error.status = response.status; throw error; }
    try { return JSON.parse(body); } catch { throw new Error('The website service returned invalid status information.'); }
  }

  async releaseAccountBrowser(profile, provider, siteId, signal) {
    if (!this.bridges.entries?.get(profile?.id)?.child) return false;
    const status = await this.serviceRequest(provider, '/status', { signal });
    const account = status.providers?.find(item => item.id === siteId);
    if (account?.busy) throw new Error('Wait for this account’s running request before signing in again.');
    if (!account?.browserProfileOpen) return false;
    await this.serviceRequest(provider, `/profiles/${siteId}/close`, { method: 'POST', signal });
    return true;
  }

  waitUntilIdle(siteId, providerId, context) {
    this.pendingSiteId = siteId; this.pendingProviderId = providerId;
    this.pendingContext = context;
    this.step('waiting-idle', 'waiting-idle', 'The new sign-in is saved. Existing chats can finish before Gravity reloads the connection.');
    this.changed({ recoveryAction: 'retry' });
    if (!this.pendingTimer) {
      this.pendingTimer = setInterval(() => {
        if (this.closing || !this.pendingSiteId) { clearInterval(this.pendingTimer); this.pendingTimer = null; return; }
        if (this.operation || this.child || this.store.data.conversations.some(item => item.providerId === this.pendingProviderId && item.status === 'running')) return;
        const pending = this.pendingSiteId, pendingContext = this.pendingContext;
        this.pendingSiteId = null; this.pendingContext = null;
        clearInterval(this.pendingTimer); this.pendingTimer = null;
        void this.connect(pending, {}, pendingContext).catch(() => {});
      }, 1000);
      this.pendingTimer.unref?.();
    }
    return this.status();
  }

  async connect(siteId, { forceLogin = false, browserChannel } = {}, resumed) {
    if (typeof forceLogin !== 'boolean') throw new Error('Sign-in preference must be true or false.');
    if (browserChannel !== undefined && !['chrome', 'msedge'].includes(browserChannel)) throw new Error('Choose Chrome or Edge.');
    const site = SITES.find(item => item.id === siteId);
    if (!site) throw new Error('Choose ChatGPT, Z.ai, DeepSeek, or Qwen.');
    if (this.closing) throw new Error('Gravity is shutting down.');
    const browserProbe = this.browserProbe;
    if (this.operation || (this.child && !browserProbe)) throw new Error('Website setup is already in progress.');
    const pendingContext = resumed || (!forceLogin && this.pendingSiteId === siteId ? this.pendingContext : undefined);
    clearInterval(this.pendingTimer); this.pendingTimer = null; this.pendingSiteId = null; this.pendingContext = null;
    const controller = new AbortController(); this.operation = controller;
    this.operationDone = new Promise(resolve => { this.resolveOperationDone = resolve; });
    this.cancellationStop = null;
    this.changed({ busy: true, phase: 'preparing', siteId, message: `Preparing ${site.label}.`, error: undefined, errorCode: undefined, recoveryAction: undefined, stage: undefined, externallyRunning: false });
    let recovery, stoppedForReload = false;
    try {
      if (browserProbe) {
        // Reserve the connection operation before waiting, so duplicate clicks
        // remain rejected and cancellation also covers this short probe wait.
        try { await this.waitForBrowserProbe(browserProbe, controller.signal); }
        catch { controller.signal.throwIfAborted(); }
        await this.waitForHelperClose(); controller.signal.throwIfAborted();
        if (this.child) throw new Error('The browser check is still closing. Wait a moment and try Connect again.');
      }
      await this.refresh({ owner: controller }); if (!this.companion) throw new Error(this.state.error || unavailable);
      const companion = this.companion;
      const previousEntry = pendingContext?.previousEntry || structuredClone(this.privateConfig?.providers[siteId]);
      const reloadAccount = forceLogin || pendingContext?.reloadAccount === true;
      let preset = await this.preset(controller.signal, companion);
      this.localKey = preset.provider.apiKey;
      let current = this.store.data.providers.find(item => item.type === 'openai' && sameUrl(item.baseUrl, preset.provider.baseUrl) && item.managedBy !== 'browser-connector');
      let currentProfile = current && this.matchingProfile(companion, current.id);
      if (forceLogin || !this.state.sites.find(item => item.id === siteId)?.enabled) {
        this.ensureNoAccountConversation(current?.id, siteId);
        if (forceLogin && currentProfile) await this.releaseAccountBrowser(currentProfile, this.store.provider(current.id), siteId, controller.signal);
        controller.signal.throwIfAborted();
        this.changed({ phase: 'login', message: `Sign in to ${site.label}, open a new empty chat, then close the separate browser. Gravity will finish setup automatically.` });
        await this.helper(['login', siteId, '--app', ...(browserChannel ? ['--browser', browserChannel] : [])], { signal: controller.signal, login: true, companion });
        await this.refresh({ owner: controller, companion });
        if (!this.state.sites.find(item => item.id === siteId)?.enabled) throw new Error('The website did not save its sign-in. Click Connect to try again.');
        preset = await this.preset(controller.signal, companion); this.localKey = preset.provider.apiKey;
        current = this.store.data.providers.find(item => item.type === 'openai' && sameUrl(item.baseUrl, preset.provider.baseUrl) && item.managedBy !== 'browser-connector');
        currentProfile = current && this.matchingProfile(companion, current.id);
      }
      controller.signal.throwIfAborted();
      if (current && this.store.data.conversations.some(item => item.providerId === current.id && item.status === 'running')) return this.waitUntilIdle(siteId, current.id,
        { previousEntry, expectedEntry: pendingContext?.expectedEntry || structuredClone(this.privateConfig?.providers[siteId]), reloadAccount });
      this.ensureNoConversation(current?.id);
      const active = current && this.bridges.status().some(item => this.store.data.bridgeProfiles.find(profile => profile.id === item.id)?.providerId === current.id && (item.running || item.starting));
      if (active && this.store.provider(current.id).apiKey !== preset.provider.apiKey) throw new Error('Stop the existing website bridge before updating its local connection key.');
      const saved = this.store.saveProvider({ ...(current ? { id: current.id } : {}), name: current?.name || 'Gravity Web2API', type: 'openai',
        managedBy: 'web2api',
        baseUrl: preset.provider.baseUrl, models: current?.models || [], defaultModel: current?.defaultModel || '',
        ...(active ? {} : { apiKey: preset.provider.apiKey, headers: {} }) });
      let profile = currentProfile;
      if (profile && this.profileNeedsUpdate(profile, companion)) {
        this.ensureNoConversation(saved.id);
        if (this.bridges.status().some(item => item.id === profile.id && (item.running || item.starting))) await this.bridges.stop(profile.id);
        this.ensureNoConversation(saved.id);
        profile = this.store.saveBridgeProfile(this.desiredProfile(preset, saved.id, profile));
      }
      if (!profile) profile = this.store.saveBridgeProfile(this.desiredProfile(preset, saved.id));
      this.store.updateSettings({ bridgesAutoStart: true });
      this.changed({ providerId: saved.id, bridgeId: profile.id });
      this.step('discovering-models', 'starting', 'Checking the saved website service.');
      let models, reachable = false;
      try { models = await this.discover(this.store.provider(saved.id), { signal: controller.signal, timeoutMs: 3000 }); reachable = true; }
      catch (error) {
        controller.signal.throwIfAborted();
        if ([401, 403].includes(error.status)) throw loginFailure('local_auth_conflict', 'discovering-models', siteId);
      }
      const runtime = this.bridges.status().find(item => item.id === profile.id);
      const owned = !!this.bridges.entries?.get(profile.id)?.child;
      if (reachable && owned && (!models.includes(site.model) || reloadAccount)) {
        this.ensureNoConversation(saved.id);
        recovery = { companion, profileId: profile.id, providerId: saved.id, previous: previousEntry,
          expected: pendingContext?.expectedEntry || structuredClone(this.privateConfig?.providers[siteId]) };
        await this.bridges.stop(profile.id); stoppedForReload = true; reachable = false;
      }
      if (reachable) {
        if (runtime?.state !== 'ready') await this.bridges.check(profile.id);
        this.changed({ externallyRunning: !(this.bridges.entries?.get(profile.id)?.child) });
      } else {
        this.ensureNoConversation(saved.id);
        const currentRuntime = this.bridges.status().find(item => item.id === profile.id);
        if (currentRuntime?.running || currentRuntime?.starting) await this.bridges.stop(profile.id);
        this.ensureNoConversation(saved.id);
        controller.signal.throwIfAborted(); this.startingBridgeId = profile.id;
        this.step('starting-service', 'starting', 'Starting your website connection.');
        await this.bridges.start(profile.id);
        this.step('discovering-models', 'starting', 'Discovering the prepared website models.');
        models = await this.discover(this.store.provider(saved.id), { signal: controller.signal, timeoutMs: 15000 });
      }
      controller.signal.throwIfAborted();
      if (!Array.isArray(models) || !models.includes(site.model)) throw loginFailure('service_reload_required', 'discovering-models', siteId);
      this.ensureNoConversation(saved.id);
      this.store.saveProvider({ id: saved.id, name: saved.name, type: 'openai', managedBy: 'web2api', baseUrl: saved.baseUrl, models, defaultModel: site.model });
      this.changed({ phase: 'ready', message: `${site.label} is connected. Gravity will start your saved service automatically.`, defaultModel: site.model, models, error: undefined });
    } catch (error) {
      const inferredCode = Object.hasOwn(LOGIN_ERRORS, error?.code || '') ? error.code : error?.status === 409 ? 'active_request'
        : /port.+unavailable|port.+in use|EADDRINUSE/i.test(error?.message || '') ? 'port_conflict'
        : this.state.stage === 'discovering-models' ? 'model_discovery_failed' : this.state.errorCode;
      const message = controller.signal.aborted ? 'Setup cancelled. Your saved website sign-ins are kept.'
        : inferredCode ? LOGIN_ERRORS[inferredCode][0] : this.safeError(error);
      this.changed({ phase: controller.signal.aborted ? 'cancelled' : 'error', error: controller.signal.aborted ? undefined : message, message,
        errorCode: controller.signal.aborted ? 'setup_cancelled' : inferredCode,
        recoveryAction: controller.signal.aborted ? 'retry' : error?.recoveryAction || (inferredCode ? LOGIN_ERRORS[inferredCode]?.[1] : undefined) || this.state.recoveryAction || 'inspect' });
      throw new Error(message);
    } finally {
      if (controller.signal.aborted && this.startingBridgeId && !this.cancellationStop) {
        this.cancellationStop = this.bridges.stop(this.startingBridgeId).catch(() => {});
      }
      await this.cancellationStop;
      await this.waitForHelperClose();
      if (stoppedForReload && this.state.phase !== 'ready' && recovery && !this.closing) {
        try {
          this.changed({ stage: 'restoring-service' });
          if (this.startingBridgeId && this.bridges.entries?.get(this.startingBridgeId)?.child) await this.bridges.stop(this.startingBridgeId);
          this.ensureNoConversation(recovery.providerId);
          if (recovery.previous && recovery.expected) await this.helper(['restore-site', siteId], { companion: recovery.companion,
            stdinPayload: JSON.stringify({ previous: recovery.previous, expected: recovery.expected }) });
          await this.bridges.start(recovery.profileId);
          this.changed({ restoredConnection: true, message: `${this.state.message} The previous working connection was restored.` });
        } catch { this.changed({ restoredConnection: false, message: `${this.state.message} The saved connection needs a manual restart.`, recoveryAction: 'start' }); }
      }
      if (this.operation === controller) this.operation = null;
      this.startingBridgeId = null;
      this.changed({ busy: !!this.child, ...(this.child ? { phase: 'error', error: 'The website helper is still closing. Wait before trying again.', message: 'The website helper is still closing. Wait before trying again.' } : {}) });
      this.resolveOperationDone?.(); this.resolveOperationDone = null;
    }
    return this.status();
  }

  safeError(error) {
    let message = String(error?.message || 'Website setup failed. Try Connect again.');
    if (this.localKey) message = message.split(this.localKey).join('[redacted]');
    for (const provider of this.store.data.providers) {
      try {
        const privateProvider = this.store.provider(provider.id);
        for (const secret of [privateProvider.apiKey, ...Object.values(privateProvider.headers || {})]) {
          if (typeof secret === 'string' && secret.length > 3) message = message.split(secret).join('[redacted]');
        }
      } catch { /* Unavailable encrypted keys are never printed. */ }
    }
    return message.slice(0, 1800);
  }

  finishLogin() {
    if (!this.operation || this.state.phase !== 'login' || !['deepseek', 'qwen'].includes(this.state.siteId) || !this.child?.stdin?.writable) {
      throw new Error('There is no website sign-in waiting for confirmation.');
    }
    this.child.stdin.write('\n'); this.changed({ phase: 'verifying', message: 'Checking your saved website sign-in.' });
    return this.status();
  }

  async cancel() {
    if (this.pendingSiteId) {
      clearInterval(this.pendingTimer); this.pendingTimer = null; this.pendingSiteId = null; this.pendingContext = null;
      this.changed({ phase: 'cancelled', message: 'Setup cancelled. Your saved website sign-ins are kept.', recoveryAction: 'retry', error: undefined, errorCode: 'setup_cancelled' });
    }
    const operation = this.operation;
    if (!operation) return this.status();
    operation.abort(cancelled());
    this.browserProbeController?.abort(cancelled());
    if (this.startingBridgeId && !this.cancellationStop) this.cancellationStop = this.bridges.stop(this.startingBridgeId).catch(() => {});
    await this.cancellationStop;
    return this.status();
  }

  async waitForHelperClose() {
    if (!this.child || !this.helperExit) return;
    let timer;
    try { await Promise.race([this.helperExit, new Promise(resolve => { timer = setTimeout(resolve, this.helperCloseTimeoutMs); })]); }
    finally { clearTimeout(timer); }
  }

  async close() {
    this.closing = true;
    this.browserProbeController?.abort(cancelled());
    clearInterval(this.pendingTimer); this.pendingTimer = null; this.pendingSiteId = null; this.pendingContext = null;
    const done = this.operationDone;
    await this.cancel();
    if (this.operation && done) {
      let timer;
      try { await Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, 18000); })]); }
      finally { clearTimeout(timer); }
    }
    await this.waitForHelperClose();
  }
}
