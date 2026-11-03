import fs from 'node:fs/promises';
import path from 'node:path';
import { Gateway } from './gateway.mjs';
import { ManagedBridges } from './managed-bridges.mjs';
import { normalizeBridgeProfile, normalizeBridgeEnv, validateBridgeUrls, isLoopback } from './bridge-profiles.mjs';

const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const secretName = /(?:authorization|cookie|password|secret|credential|api[_-]?key|access[_-]?token|session[_-]?(?:key|token)|(?:^|_)token$)/i;
const blockedHeaders = new Set(['host', 'content-length', 'connection', 'cookie', 'set-cookie', 'proxy-authorization']);

function text(value, label, maximum = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > maximum) throw new Error(`${label} must be nonempty text of at most ${maximum} characters.`);
  return value.trim();
}
function id(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error(`${label} must use 1–128 letters, digits, dots, underscores, or hyphens and start with a letter or digit.`);
  return value;
}
function variable(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(value)) throw new Error(`${label} must name a valid environment variable.`);
  return value;
}
function environmentValue(environment, name, label) {
  variable(name, label);
  const value = environment[name];
  if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 65536) throw new Error(`Set the required environment variable ${name} before starting the service.`);
  return value;
}
function unknownKeys(input, allowed, label) {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error(`${label} contains an unsupported field. Check the configuration example.`);
}
function normalizeHeaders(input, from, environment) {
  const result = Object.create(null), names = new Set();
  for (const [source, isReference] of [[input ?? {}, false], [from ?? {}, true]]) {
    if (!record(source) || Object.keys(source).length > 64) throw new Error('Provider headers must be an object with at most 64 entries.');
    for (const [name, raw] of Object.entries(source)) {
      const canonical = name.toLowerCase();
      if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || name.length > 200 || blockedHeaders.has(canonical) || names.has(canonical)) throw new Error('Provider header names must be unique and may not override cookies or connection headers.');
      if (!isReference && secretName.test(name)) throw new Error('Authentication headers must reference environment variables through headerEnv.');
      const value = isReference ? environmentValue(environment, raw, 'Header environment reference') : raw;
      if (typeof value !== 'string' || /[\r\n\0]/.test(value) || value.length > 16384) throw new Error('Provider header values must be text without line breaks.');
      names.add(canonical); Object.defineProperty(result, name, { value, enumerable: true });
    }
  }
  return result;
}

function normalizeProvider(input, environment) {
  if (!record(input)) throw new Error('Each provider must be an object.');
  unknownKeys(input, ['id', 'name', 'type', 'baseUrl', 'models', 'defaultModel', 'apiKeyEnv', 'headers', 'headerEnv'], 'Provider');
  const provider = { id: id(input.id, 'Provider ID'), name: text(input.name ?? input.id, 'Provider name', 200), type: input.type ?? 'openai', baseUrl: text(input.baseUrl, 'Provider base URL') };
  if (!['openai', 'anthropic', 'gemini'].includes(provider.type)) throw new Error('Provider type must be openai, anthropic, or gemini.');
  validateBridgeUrls({ providerId: provider.id, launchMode: 'external' }, provider);
  if (input.models !== undefined && (!Array.isArray(input.models) || input.models.length > 1000)) throw new Error('Provider models must be an array of at most 1,000 model IDs.');
  provider.models = [...new Set((input.models ?? []).map(model => text(model, 'Model ID', 512)))];
  if (input.defaultModel !== undefined && typeof input.defaultModel !== 'string') throw new Error('Default model must be text.');
  provider.defaultModel = input.defaultModel ? text(input.defaultModel, 'Default model', 512) : provider.models[0] || '';
  if (provider.defaultModel && !provider.models.includes(provider.defaultModel)) provider.models.push(provider.defaultModel);
  provider.apiKey = input.apiKeyEnv === undefined ? '' : environmentValue(environment, input.apiKeyEnv, 'Provider key environment reference');
  if (/[\r\n]/.test(provider.apiKey)) throw new Error('Provider API keys must not contain line breaks.');
  provider.headers = normalizeHeaders(input.headers, input.headerEnv, environment);
  return provider;
}

function normalizeProfile(input, providers, environment, directory) {
  if (!record(input)) throw new Error('Each bridge must be an object.');
  unknownKeys(input, ['id', 'name', 'providerId', 'launchMode', 'executable', 'args', 'cwd', 'healthUrl', 'startupTimeoutMs', 'env', 'envFrom', 'enabled'], 'Bridge');
  const bridgeId = id(input.id, 'Bridge ID');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('Bridge enabled must be a boolean.');
  const provider = providers.find(p => p.id === input.providerId);
  if (!provider) throw new Error('Every bridge must reference a configured provider ID.');
  const cwd = input.cwd === undefined || input.cwd === '' ? directory : path.resolve(directory, text(input.cwd, 'Bridge working directory', 32768));
  const profile = normalizeBridgeProfile({ ...input, cwd }, provider, { id: bridgeId });
  const direct = normalizeBridgeEnv(input.env ?? {});
  if (Object.keys(direct).some(name => secretName.test(name))) throw new Error('Secret bridge environment values must use envFrom references.');
  const references = input.envFrom ?? {};
  if (!record(references) || Object.keys(references).length > 128) throw new Error('Bridge envFrom must be an object with at most 128 environment references.');
  const result = { ...direct };
  const names = new Set(Object.keys(direct).map(name => process.platform === 'win32' ? name.toUpperCase() : name));
  for (const [name, hostName] of Object.entries(references)) {
    variable(name, 'Bridge environment name'); variable(hostName, 'Bridge environment reference');
    const canonical = process.platform === 'win32' ? name.toUpperCase() : name;
    if (names.has(canonical)) throw new Error('Bridge env and envFrom names may not overlap.');
    names.add(canonical);
    // Disabled templates are validated but do not require credentials until enabled.
    Object.defineProperty(result, name, { value: input.enabled === false ? '' : environmentValue(environment, hostName, 'Bridge environment reference'), enumerable: true });
  }
  return { ...profile, env: normalizeBridgeEnv(result), enabled: input.enabled !== false };
}

export class UniversalService {
  constructor(config, { configDirectory = process.cwd(), env = process.env, onChange = () => {} } = {}) {
    if (!record(config)) throw new Error('Service configuration must be a JSON object.');
    unknownKeys(config, ['port', 'providers', 'bridges', 'gatewayTokenEnv'], 'Service configuration');
    if (!Array.isArray(config.providers) || !config.providers.length || config.providers.length > 64) throw new Error('Configure between 1 and 64 providers.');
    if (config.bridges !== undefined && (!Array.isArray(config.bridges) || config.bridges.length > 64)) throw new Error('Bridges must be an array with at most 64 profiles.');
    this.port = config.port ?? 4318;
    if (!Number.isInteger(this.port) || (this.port !== 0 && (this.port < 1024 || this.port > 65535))) throw new Error('Gateway port must be 0 for automatic selection, or an integer from 1024 to 65535.');
    this.token = environmentValue(env, config.gatewayTokenEnv ?? 'GATEWAY_TOKEN', 'Gateway token environment reference');
    if (this.token.length < 16 || /[\r\n]/.test(this.token)) throw new Error('Gateway token must contain at least 16 characters without line breaks.');
    const providers = config.providers.map(provider => normalizeProvider(provider, env));
    if (new Set(providers.map(provider => provider.id)).size !== providers.length) throw new Error('Provider IDs must be unique.');
    const directory = path.resolve(configDirectory);
    const profiles = (config.bridges ?? []).map(profile => normalizeProfile(profile, providers, env, directory));
    if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new Error('Bridge IDs must be unique.');
    const active = profiles.filter(profile => profile.enabled);
    if (new Set(active.map(profile => profile.providerId)).size !== active.length) throw new Error('Each provider may have only one enabled bridge profile.');
    for (const provider of providers) {
      const url = new URL(provider.baseUrl);
      if (this.port && isLoopback(url.hostname) && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === this.port) throw new Error('A provider may not point back to the configured gateway port.');
    }
    this.providers = providers;
    this.profiles = profiles;
    this.secrets = [...new Set([this.token, ...providers.flatMap(p => [p.apiKey, ...Object.values(p.headers)]), ...profiles.flatMap(p => Object.values(p.env))].filter(Boolean))].sort((a, b) => b.length - a.length);
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    this.secretPattern = new RegExp(['\\[redacted\\]', ...this.secrets.map(escape)].join('|'), 'g');
    this.onChange = onChange;
    this.state = 'stopped'; this.error = undefined; this.startPromise = null; this.stopPromise = null; this.stopping = false;
    this.store = {
      data: { bridgeProfiles: active },
      bridgeProfile: bridgeId => { const profile = active.find(p => p.id === bridgeId); if (!profile) throw new Error('Bridge profile not found.'); return structuredClone(profile); },
      provider: providerId => { const provider = providers.find(p => p.id === providerId); if (!provider) throw new Error('Provider not found.'); return structuredClone(provider); }
    };
    this.createServices();
  }
  redact(value) {
    return String(value ?? 'Service operation failed.').slice(0, 32768).replace(this.secretPattern, '[redacted]').slice(0, 3000);
  }
  changed() { try { this.onChange(this.status()); } catch { /* Observers must not prevent cleanup. */ } }
  createServices() {
    this.gateway = new Gateway({ getProviders: () => this.providers.map(({ apiKey, headers, ...provider }) => provider), getProvider: providerId => this.store.provider(providerId), onChange: () => this.changed() });
    this.bridges = new ManagedBridges({ store: this.store, onChange: () => this.changed() });
  }
  status() {
    return {
      state: this.state,
      gateway: this.gateway?.status() ?? { running: false },
      bridges: (this.bridges?.status() ?? []).map(profile => ({ ...profile, logs: profile.logs.map(log => this.redact(log)), ...(profile.error ? { error: this.redact(profile.error) } : {}) })),
      providers: this.providers.map(provider => ({ id: provider.id, name: provider.name, type: provider.type, models: [...provider.models] })),
      ...(this.error ? { error: this.error } : {})
    };
  }
  async start() {
    if (this.state === 'running') return this.status();
    if (this.startPromise) return this.startPromise;
    if (this.stopPromise) throw new Error('Wait for the service to finish stopping before restarting it.');
    this.stopping = false; this.state = 'starting'; this.error = undefined; this.changed();
    this.startPromise = this.launch();
    try { return await this.startPromise; } finally { this.startPromise = null; }
  }
  async launch() {
    try {
      if (this.bridges.closing) {
        // Do not forget an earlier manager until every owned process is confirmed stopped.
        const cleanup = await Promise.allSettled([this.gateway.stop(), this.bridges.shutdown()]);
        const failed = cleanup.find(result => result.status === 'rejected');
        if (failed) throw new Error(`Previous service cleanup is incomplete: ${failed.reason?.message || 'could not stop an owned process'}`);
        if (this.stopping) throw new Error('Service startup cancelled.');
        this.createServices();
      }
      for (const profile of this.store.data.bridgeProfiles) {
        if (this.stopping) throw new Error('Service startup cancelled.');
        if (profile.launchMode === 'external') await this.bridges.check(profile.id);
        else await this.bridges.start(profile.id);
      }
      if (this.stopping) throw new Error('Service startup cancelled.');
      await this.gateway.start({ port: this.port, token: this.token });
      if (this.stopping) throw new Error('Service startup cancelled.');
      this.state = 'running'; this.changed(); return this.status();
    } catch (error) {
      const cleanup = await Promise.allSettled([this.gateway.stop(), this.bridges.shutdown()]);
      const cleanupError = cleanup.find(result => result.status === 'rejected');
      this.error = this.redact(`${error.message || 'Service startup failed.'}${cleanupError ? ` Cleanup failed: ${cleanupError.reason?.message || 'Could not stop an owned process.'}` : ''}`);
      this.state = this.stopping && !cleanupError ? 'stopped' : 'error'; this.changed(); throw new Error(this.error);
    }
  }
  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true; this.state = 'stopping'; this.changed();
    this.stopPromise = (async () => {
      const results = await Promise.allSettled([this.gateway.stop(), this.bridges.shutdown()]);
      await this.startPromise?.catch(() => {});
      const failed = results.find(result => result.status === 'rejected');
      if (failed) { this.error = this.redact(failed.reason?.message); this.state = 'error'; this.changed(); throw new Error(this.error); }
      this.state = 'stopped'; this.error = undefined; this.changed(); return this.status();
    })();
    try { return await this.stopPromise; } finally { this.stopPromise = null; }
  }
}

export async function loadUniversalConfig(file, options = {}) {
  const absolute = path.resolve(file);
  const stat = await fs.stat(absolute);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Configuration must be a JSON file of at most 1 MiB.');
  let config;
  try { config = JSON.parse(await fs.readFile(absolute, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) throw new Error('Service configuration must contain valid JSON.'); throw error; }
  return new UniversalService(config, { ...options, configDirectory: path.dirname(absolute) });
}
