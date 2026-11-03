import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { discoverModels } from './providers.mjs';
import { normalizeBridgeProfile, validateBridgeUrls } from './bridge-profiles.mjs';

const MAX_LOG_LINES = 60;
const MAX_LINE = 8192;
const alive = entry => !!entry.child?.pid && !entry.exited;

function redactor(profile, provider) {
  const secrets = [...new Set([...Object.values(profile.env || {}), provider.apiKey, ...Object.values(provider.headers || {})]
    .flatMap(value => typeof value === 'string' ? [value, JSON.stringify(value).slice(1, -1), ...value.split(/[\r\n]+/)] : [])
    .filter(Boolean))].sort((a, b) => b.length - a.length);
  const pattern = secrets.length ? new RegExp(secrets.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;
  return value => {
    let text = String(value ?? '');
    // A single pass avoids reprocessing the redaction marker for short env values.
    if (pattern) text = text.replace(pattern, '[redacted]');
    return text.replace(/((?:__Secure-[\w-]+|cookie|authorization|x-api-key|api[_-]?key|access[_-]?token|session[_-]?(?:key|token)|password|secret)["'\s:=]+)[^\r\n]+/gi, '$1[redacted]');
  };
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function availablePort(url) {
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const hosts = hostname === 'localhost' ? ['127.0.0.1', '::1'] : [hostname];
  for (const host of hosts) {
    await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', error => {
        if (hosts.length > 1 && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) resolve();
        else reject(new Error(`Provider port ${port} is unavailable (${error.code || 'listen failed'}). Stop the existing service, choose another port, or use external mode.`));
      });
      server.listen({ host, port, exclusive: true }, () => server.close(error => error ? reject(error) : resolve()));
    });
  }
}

function healthHeaders(provider) {
  const headers = new Headers({ accept: 'application/json' });
  if (provider.type === 'anthropic') headers.set('anthropic-version', '2023-06-01');
  if (provider.apiKey) {
    headers.set(provider.type === 'anthropic' ? 'x-api-key' : provider.type === 'gemini' ? 'x-goog-api-key' : 'authorization',
      provider.type === 'openai' ? `Bearer ${provider.apiKey}` : provider.apiKey);
  }
  for (const [name, value] of Object.entries(provider.headers || {})) {
    if (value != null && !['host', 'content-length', 'connection', 'cookie'].includes(name.toLowerCase())) headers.set(name, value);
  }
  return headers;
}

function launchEnvironment(overrides) {
  const env = { ...process.env };
  for (const [name, value] of Object.entries(overrides || {})) {
    // Windows names are case-insensitive; avoid Node choosing an inherited alias.
    if (process.platform === 'win32') for (const existing of Object.keys(env)) if (existing.toUpperCase() === name.toUpperCase()) delete env[existing];
    Object.defineProperty(env, name, { value, enumerable: true, writable: true, configurable: true });
  }
  return env;
}

export class ManagedBridges {
  constructor({ store, onChange = () => {} }) {
    this.store = store;
    this.onChange = onChange;
    this.entries = new Map();
    this.reservations = new Map();
    this.closing = false;
  }

  status() {
    return this.store.data.bridgeProfiles.map(profile => this.snapshot(this.entries.get(profile.id) || { id: profile.id, state: 'stopped', logs: [] }));
  }

  snapshot(entry) {
    return { id: entry.id, running: alive(entry) || !!entry.connected, starting: !!entry.starting,
      state: entry.state, logs: [...entry.logs], ...(entry.error ? { error: entry.error } : {}) };
  }

  changed() { try { this.onChange(); } catch { /* A detached view cannot prevent process cleanup. */ } }

  entry(id) {
    this.store.bridgeProfile(id);
    if (!this.entries.has(id)) this.entries.set(id, { id, state: 'stopped', logs: [], connected: false, starting: false, child: null });
    return this.entries.get(id);
  }

  configuration(id) {
    const saved = this.store.bridgeProfile(id), provider = this.store.provider(saved.providerId);
    const profile = { ...normalizeBridgeProfile(saved, provider, saved), env: saved.env };
    return { profile, provider };
  }

  log(entry, value) {
    const text = entry.redact ? entry.redact(value) : String(value);
    entry.logs.push(text.slice(0, 1500));
    entry.logs = entry.logs.slice(-MAX_LOG_LINES);
    this.changed();
  }

  streamLog(entry, stream) {
    const decoder = new StringDecoder('utf8');
    let buffer = '', dropping = false;
    const accept = value => {
      buffer += value;
      let boundary;
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary).replace(/\r$/, '');
        if (!dropping) this.log(entry, line.length > MAX_LINE ? '[Output line omitted: exceeds 8192 characters.]' : line);
        buffer = buffer.slice(boundary + 1); dropping = false;
      }
      if (buffer.length > MAX_LINE) {
        if (!dropping) this.log(entry, '[Output line omitted: exceeds 8192 characters.]');
        buffer = ''; dropping = true;
      }
    };
    stream.on('data', chunk => accept(decoder.write(chunk)));
    stream.on('end', () => { accept(decoder.end()); if (buffer && !dropping) this.log(entry, buffer); buffer = ''; });
  }

  async start(id) {
    if (this.closing) throw new Error('The application is shutting down.');
    const entry = this.entry(id);
    if (entry.operation || entry.stopPromise || entry.child || entry.connected) throw new Error('This bridge is already starting, connected, or running. Stop it before starting again.');
    const { profile, provider } = this.configuration(id);
    return this.run(entry, profile, provider, 'start');
  }

  async check(id) {
    if (this.closing) throw new Error('The application is shutting down.');
    const entry = this.entry(id);
    if (entry.operation || entry.stopPromise) throw new Error('A bridge operation is already in progress.');
    const { profile, provider } = this.configuration(id);
    return this.run(entry, profile, provider, 'check');
  }

  run(entry, profile, provider, operation) {
    const controller = new AbortController();
    entry.controller = controller;
    entry.redact = redactor(profile, provider);
    entry.starting = true; entry.state = 'starting'; entry.error = undefined; entry.connected = false;
    if (operation === 'start') entry.logs = [];
    this.log(entry, operation === 'check' || profile.launchMode === 'external' ? 'Checking the configured service. No process is launched.' : 'Starting the configured executable. Waiting for readiness…');
    entry.operation = (async () => {
      try {
        if (operation === 'start' && profile.launchMode === 'managed') {
          await this.launch(entry, profile, provider, controller);
          const deadline = Date.now() + profile.startupTimeoutMs;
          let lastError;
          while (Date.now() < deadline) {
            controller.signal.throwIfAborted();
            try {
              await this.probe(profile, provider, controller.signal, Math.min(2000, Math.max(1, deadline - Date.now())));
              lastError = null; break;
            } catch (error) {
              controller.signal.throwIfAborted();
              if ([401, 403, 404, 405].includes(error.status)) throw error;
              lastError = error;
            }
            await delay(Math.min(300, Math.max(1, deadline - Date.now())), controller.signal);
          }
          if (lastError || Date.now() >= deadline) throw new Error(`Bridge startup exceeded ${profile.startupTimeoutMs / 1000} seconds. ${lastError?.message || 'The readiness endpoint did not respond.'}`);
        } else await this.probe(profile, provider, controller.signal, Math.min(profile.startupTimeoutMs, 15000));
        controller.signal.throwIfAborted();
        if (operation === 'start' && profile.launchMode === 'managed' && !alive(entry)) throw new Error('The managed process exited before it became ready.');
        entry.connected = true; entry.state = 'ready';
        this.log(entry, 'Service is reachable. Send a chat to verify model generation and tool support.');
      } catch (error) {
        const message = entry.redact(error?.message || 'Bridge operation failed.');
        let cleanupError;
        if ((operation === 'start' && profile.launchMode === 'managed') || (entry.child && entry.exited)) {
          try { await this.terminate(entry); }
          catch (stopError) { cleanupError = entry.redact(stopError.message); }
          // terminate releases the reservation only once cleanup succeeds. A failed
          // stop must retain ownership even when the process has not bound its port.
        }
        entry.connected = false;
        const stopped = entry.stopping && !cleanupError;
        entry.state = stopped ? 'stopped' : 'error';
        entry.error = stopped ? undefined : cleanupError || message;
        if (!stopped) this.log(entry, entry.error);
        throw new Error(stopped ? 'Bridge stopped before the operation completed.' : entry.error);
      } finally {
        entry.starting = false; entry.operation = null;
        if (entry.controller === controller) entry.controller = null;
        this.changed();
      }
      return this.snapshot(entry);
    })();
    return entry.operation;
  }

  async probe(profile, provider, signal, timeoutMs) {
    validateBridgeUrls(profile, provider);
    if (!profile.healthUrl) {
      try { return await discoverModels(provider, { signal, timeoutMs }); }
      catch (error) {
        if ([401, 403].includes(error.status)) {
          const unauthorized = new Error(`Model discovery returned HTTP ${error.status}. Check the linked provider’s API authentication.`);
          unauthorized.status = error.status; throw unauthorized;
        }
        if ([404, 405].includes(error.status)) {
          const unavailable = new Error('The bridge does not expose model discovery. Configure a same-origin health URL and enter its documented model IDs in provider settings.');
          unavailable.status = error.status; throw unavailable;
        }
        throw error;
      }
    }
    const scope = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let response;
    try { response = await fetch(profile.healthUrl, { headers: healthHeaders(provider), signal: scope, redirect: 'error' }); }
    catch (error) { if (signal.aborted) throw signal.reason; throw new Error(`Cannot reach the bridge health endpoint: ${error.message}`); }
    await response.body?.cancel().catch(() => {});
    if (!response.ok) {
      const error = new Error(`Bridge health endpoint returned HTTP ${response.status}${[401, 403].includes(response.status) ? '. Check the linked provider’s API authentication.' : '.'}`);
      error.status = response.status; throw error;
    }
  }

  async launch(entry, profile, provider, controller) {
    const signal = controller.signal;
    if (!(await fs.stat(profile.executable)).isFile()) throw new Error('The selected executable is not a file.');
    if (profile.cwd && !(await fs.stat(profile.cwd)).isDirectory()) throw new Error('The working directory does not exist.');
    const url = validateBridgeUrls(profile, provider);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    signal.throwIfAborted();
    if (this.reservations.has(port)) throw new Error(`Provider port ${port} is already reserved by another managed bridge.`);
    this.reservations.set(port, entry.id); entry.port = port;
    await availablePort(url);
    signal.throwIfAborted();
    const child = spawn(profile.executable, profile.args, {
      ...(profile.cwd ? { cwd: profile.cwd } : {}), env: launchEnvironment(profile.env),
      shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    entry.child = child; entry.exited = false;
    this.streamLog(entry, child.stdout); this.streamLog(entry, child.stderr);
    child.once('error', error => {
      entry.exited = true;
      (entry.controller || controller).abort(new Error(`Cannot launch configured executable: ${entry.redact(error.message)}`));
    });
    child.once('exit', (code, signalName) => {
      entry.exited = true; entry.connected = false;
      if (!entry.stopping && !entry.terminating) {
        const error = new Error(`Managed bridge exited${signalName ? ` (${signalName})` : ` with code ${code}`}. Check its configuration and logs.`);
        entry.error = error.message; entry.state = 'error'; (entry.controller || controller).abort(error);
        this.log(entry, error.message);
        if (!entry.operation) void this.terminate(entry).catch(error => this.log(entry, error.message));
      }
      this.changed();
    });
    this.changed();
  }

  release(entry) {
    if (entry.port !== undefined && this.reservations.get(entry.port) === entry.id) this.reservations.delete(entry.port);
    entry.port = undefined;
  }

  async terminate(entry) {
    if (entry.termination) return entry.termination;
    const child = entry.child;
    if (!child) { this.release(entry); return; }
    entry.terminating = true;
    entry.termination = Promise.resolve().then(async () => {
      try {
        if (child.pid) {
          if (process.platform === 'win32' && !entry.exited) {
            const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
            await new Promise((resolve, reject) => execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, maxBuffer: 32768 }, error => {
              if (error && !entry.exited) reject(new Error('Could not terminate the owned bridge process tree. Stop it in Task Manager before changing its profile.'));
              else resolve();
            }));
          } else if (process.platform !== 'win32') {
            try { process.kill(-child.pid, 'SIGKILL'); }
            catch (error) { if (error.code !== 'ESRCH') throw error; }
          }
          if (!entry.exited) await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { child.removeListener('exit', finish); reject(new Error('The owned bridge process did not exit after termination.')); }, 3000);
            const finish = () => { clearTimeout(timer); resolve(); };
            child.once('exit', finish);
            if (entry.exited) { child.removeListener('exit', finish); finish(); }
          });
        }
        if (entry.child === child) entry.child = null;
        child.stdout?.destroy(); child.stderr?.destroy();
        this.release(entry);
      } finally { entry.terminating = false; entry.termination = null; this.changed(); }
    });
    return entry.termination;
  }

  async stop(id) {
    const entry = this.entries.get(id) || this.entry(id);
    if (entry.stopPromise) return entry.stopPromise;
    entry.stopping = true; entry.connected = false;
    entry.controller?.abort(new Error('Bridge operation cancelled.'));
    entry.stopPromise = (async () => {
      try {
        await this.terminate(entry);
        await entry.operation?.catch(() => {});
        // Cancellation can occur before asynchronous file validation finishes.
        await this.terminate(entry);
        entry.state = 'stopped'; entry.error = undefined; entry.starting = false;
        this.log(entry, 'Disconnected. Only processes started by this profile are terminated.');
        return this.snapshot(entry);
      } catch (error) {
        entry.error = entry.redact ? entry.redact(error.message) : error.message; entry.state = 'error';
        throw error;
      } finally { entry.stopping = false; entry.stopPromise = null; this.changed(); }
    })();
    return entry.stopPromise;
  }

  async shutdown() {
    this.closing = true;
    const results = await Promise.allSettled([...this.entries.keys()].map(id => this.stop(id)));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
}
