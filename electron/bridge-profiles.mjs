import path from 'node:path';
import net from 'node:net';

export const ENV_MASK = '********';
const secretQuery = /(?:key|token|secret|password|authorization|signature|credential|^sig$)/i;
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);

function text(value, label, maximum, { optional = false, trim = false } = {}) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || value.includes('\0') || value.length > maximum) throw new Error(`${label} must be text of up to ${maximum} characters without null bytes.`);
  const result = trim ? value.trim() : value;
  if (!optional && !result) throw new Error(`${label} is required.`);
  return result;
}

export function isLoopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || (net.isIP(host) === 4 && host.startsWith('127.'));
}

function httpUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an absolute HTTP(S) URL.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => secretQuery.test(key))) {
    throw new Error(`${label} must use HTTP(S) without embedded credentials, secret query parameters, or a fragment. Configure authentication on the linked provider.`);
  }
  return url;
}

export function validateBridgeUrls(profile, provider) {
  if (!provider || profile.providerId !== provider.id) throw new Error('Choose a valid linked provider for this bridge.');
  const providerUrl = httpUrl(provider.baseUrl, 'Provider base URL');
  if (profile.launchMode === 'managed' && !isLoopback(providerUrl.hostname)) throw new Error('A managed bridge requires a loopback provider URL, such as http://127.0.0.1:8082/v1.');
  if (profile.healthUrl) {
    const healthUrl = httpUrl(profile.healthUrl, 'Health URL');
    if (healthUrl.origin !== providerUrl.origin) throw new Error('Health URL must share the linked provider’s origin (protocol, host, and port).');
    if (profile.launchMode === 'managed' && !isLoopback(healthUrl.hostname)) throw new Error('A managed bridge health URL must use loopback.');
  }
  return providerUrl;
}

export function normalizeBridgeProfile(input, provider, current = {}) {
  if (!record(input)) throw new Error('Bridge profile must be an object.');
  const profile = {
    id: current.id,
    name: text(input.name, 'Bridge name', 200, { trim: true }),
    providerId: text(input.providerId, 'Linked provider', 200),
    launchMode: input.launchMode,
    executable: text(input.executable, 'Executable', 32768, { optional: true, trim: true }),
    cwd: text(input.cwd, 'Working directory', 32768, { optional: true, trim: true }),
    healthUrl: text(input.healthUrl, 'Health URL', 4096, { optional: true, trim: true }),
    startupTimeoutMs: input.startupTimeoutMs ?? 30000,
  };
  if (!['external', 'managed'].includes(profile.launchMode)) throw new Error('Launch mode must be external or managed.');
  const args = input.args ?? [];
  if (!Array.isArray(args) || args.length > 256 || args.some(value => typeof value !== 'string' || value.includes('\0') || value.length > 32768) || args.join('').length > 65536) {
    throw new Error('Arguments must be an array of up to 256 strings, totaling at most 65,536 characters, without null bytes.');
  }
  profile.args = [...args];
  if (profile.executable && !path.isAbsolute(profile.executable)) throw new Error('Executable must be an absolute path.');
  if (profile.launchMode === 'managed' && !profile.executable) throw new Error('Choose an absolute executable path for a managed bridge.');
  if (profile.cwd && !path.isAbsolute(profile.cwd)) throw new Error('Working directory must be an absolute path.');
  if (process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(profile.executable)) throw new Error('Choose an executable such as node.exe or python.exe; batch files require a shell and are not supported.');
  if (!Number.isInteger(profile.startupTimeoutMs) || profile.startupTimeoutMs < 1000 || profile.startupTimeoutMs > 180000) throw new Error('Startup timeout must be between 1,000 and 180,000 milliseconds.');
  validateBridgeUrls(profile, provider);
  return profile;
}

export function normalizeBridgeEnv(input, previous = {}) {
  if (input === undefined) return { ...previous };
  if (!record(input) || Object.keys(input).length > 128) throw new Error('Environment must be an object with up to 128 string values.');
  const result = {}, names = new Set();
  let size = 0;
  for (const [name, value] of Object.entries(input)) {
    const canonical = process.platform === 'win32' ? name.toUpperCase() : name;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.length > 200 || names.has(canonical)) throw new Error('Environment names must be unique valid variable names.');
    names.add(canonical);
    if (typeof value !== 'string' || value.includes('\0') || value.length > 65536) throw new Error('Environment values must be strings of up to 65,536 characters without null bytes.');
    if (value === ENV_MASK) {
      if (!Object.prototype.hasOwnProperty.call(previous, name)) throw new Error('A masked environment value has no saved value. Enter its value or remove it.');
      Object.defineProperty(result, name, { value: previous[name], enumerable: true, writable: true, configurable: true });
    } else Object.defineProperty(result, name, { value, enumerable: true, writable: true, configurable: true });
    size += name.length + result[name].length;
  }
  if (size > 262144) throw new Error('Bridge environment exceeds 256 KiB.');
  return result;
}
