import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

export const defaultDataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '.data');
const ids = ['deepseek', 'qwen', 'chatgpt', 'zai'];
const record = value => value && typeof value === 'object' && !Array.isArray(value);

export function validateConfig(value) {
  if (!record(value) || !record(value.providers)) throw new Error('Invalid bridge configuration. Run npm run setup.');
  if (Object.keys(value).some(key => !['port', 'apiToken', 'browserChannel', 'providers'].includes(key))) throw new Error('Unknown bridge configuration field.');
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) throw new Error('Bridge port must be between 1024 and 65535.');
  if (typeof value.apiToken !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(value.apiToken)) throw new Error('Invalid local API token.');
  if (!['chrome', 'msedge'].includes(value.browserChannel)) throw new Error('Choose chrome or msedge as the browser channel.');
  if (Object.keys(value.providers).some(id => !ids.includes(id))) throw new Error('Unknown provider in bridge configuration.');
  for (const [id, provider] of Object.entries(value.providers)) {
    if (!record(provider) || typeof provider.enabled !== 'boolean') throw new Error(`Invalid ${id} configuration.`);
    if (Object.keys(provider).some(key => !['enabled', 'token', 'upstreamModel', 'browserChannel'].includes(key))) throw new Error(`Unknown ${id} configuration field.`);
    if (provider.browserChannel !== undefined && !['chrome', 'msedge'].includes(provider.browserChannel)) throw new Error(`Invalid ${id} browser channel.`);
    if (provider.token !== undefined && (!['deepseek', 'qwen'].includes(id) || typeof provider.token !== 'string' || !provider.token.length || provider.token.length > 16384 || /[\s;\x00-\x1f\x7f]/.test(provider.token))) throw new Error(`Invalid ${id} session token.`);
    if (provider.upstreamModel !== undefined && (typeof provider.upstreamModel !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(provider.upstreamModel))) throw new Error(`Invalid ${id} upstream model.`);
    if (provider.upstreamModel !== undefined && !['deepseek', 'qwen'].includes(id)) throw new Error(`${id} uses the model selected in its website.`);
  }
  return value;
}

async function privateDirectory(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Bridge data directory must not traverse links or non-directories.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Bridge data directory must be a regular directory.');
}

async function acquireConfigLock(dataDir, name) {
  const lockFile = path.join(dataDir, name);
  const deadline = Date.now() + 5000;
  let lock;
  while (!lock) {
    try { lock = await fs.open(lockFile, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`Bridge configuration is busy. Retry setup. If setup crashed, close its terminals before removing .data/${name}.`);
      await pause(20);
    }
  }
  return async () => { await lock.close(); await fs.unlink(lockFile); };
}

export async function saveConfig(dataDir, config, { exclusive = false } = {}) {
  validateConfig(config);
  await privateDirectory(dataDir);
  const file = path.join(dataDir, 'config.json');
  try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Bridge config must be a regular file.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(dataDir, `config-${randomBytes(12).toString('hex')}.tmp`);
  let handle, release;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(config, null, 2) + '\n');
    await handle.sync();
    await handle.close(); handle = null;
    // All bridge writers share this short publication lock. It permits an
    // atomic rename fallback on portable FAT/exFAT volumes without hard links,
    // while keeping concurrent first starts from publishing different tokens.
    release = await acquireConfigLock(dataDir, 'config.publish.lock');
    let exists = false;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Bridge config must be a regular file.');
      exists = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (exclusive && exists) throw Object.assign(new Error('Bridge configuration already exists.'), { code: 'EEXIST' });
    // Atomic exclusive publication gives concurrent first starts one token.
    // Replacements never expose a truncated configuration to readers.
    let linked = false;
    if (exclusive) {
      try { await fs.link(temporary, file); linked = true; }
      catch (error) {
        if (!['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EINVAL'].includes(error.code)) throw error;
      }
    }
    if (!linked) {
      // Windows can briefly deny replacement while another process reads the
      // destination. Retry the atomic rename; never delete/truncate the target.
      const deadline = Date.now() + 3000;
      while (true) {
        try { await fs.rename(temporary, file); break; }
        catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() >= deadline) throw error;
          await pause(20);
        }
      }
    }
  } finally {
    await handle?.close();
    try { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    finally { await release?.(); }
  }
  return file;
}

// Login merges into disk state and does not persist environment-only tokens.
export async function updateConfig(dataDir, update) {
  await privateDirectory(dataDir);
  const release = await acquireConfigLock(dataDir, 'config.lock');
  try {
    const config = await loadConfig(dataDir, {});
    await update(config);
    await saveConfig(dataDir, config);
    return config;
  } finally { await release(); }
}

export async function loadConfig(dataDir = defaultDataDir, env = process.env) {
  await privateDirectory(dataDir);
  const file = path.join(dataDir, 'config.json');
  let config;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error('Bridge config must be a small regular file.');
    config = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read bridge configuration. Check its JSON and file permissions.');
    config = { port: 4320, apiToken: randomBytes(32).toString('base64url'), browserChannel: 'chrome',
      providers: Object.fromEntries(ids.map(id => [id, { enabled: false }])) };
    try { await saveConfig(dataDir, config, { exclusive: true }); }
    catch (saveError) { if (saveError.code !== 'EEXIST') throw saveError; return loadConfig(dataDir, env); }
  }
  validateConfig(config);
  config = structuredClone(config);
  for (const id of ['deepseek', 'qwen']) {
    const token = env[`GRAVITY_${id.toUpperCase()}_TOKEN`];
    if (token) config.providers[id] = { ...config.providers[id], enabled: true, token };
  }
  return validateConfig(config);
}
