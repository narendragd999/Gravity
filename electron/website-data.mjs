import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const same = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const disposable = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'GrShaderCache', 'ShaderCache', 'Crashpad', 'BrowserMetrics']);

async function noLinks(target, { missing = false } = {}) {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) { if (missing && error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink() || !same(await fs.realpath(current), current)) throw new Error('Saved website data must not use links or redirected directories.');
  }
}

async function validConfig(directory) {
  await noLinks(directory);
  const info = await fs.lstat(path.join(directory, 'config.json'));
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('The saved website configuration is invalid.');
  const config = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
  if (!config.providers || typeof config.providers !== 'object' || Array.isArray(config.providers)
    || Object.keys(config).some(key => !['port', 'apiToken', 'browserChannel', 'providers'].includes(key))
    || !['chrome', 'msedge'].includes(config.browserChannel)
    || Object.entries(config.providers).some(([id, provider]) => !['chatgpt', 'zai', 'qwen', 'deepseek'].includes(id) || !provider || typeof provider.enabled !== 'boolean')
    || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || !/^[A-Za-z0-9_-]{24,128}$/.test(config.apiToken || '')) {
    throw new Error('The saved website configuration is unsupported.');
  }
  return config;
}

export async function websiteDataBusy(directory) {
  if (process.platform === 'win32') {
    const literal = path.resolve(directory).replaceAll("'", "''");
    const script = `$ErrorActionPreference='Stop'; $needle='${literal}'; $busy=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(chrome|msedge|node)\\.exe$' -and $_.CommandLine -and $_.CommandLine.IndexOf($needle,[StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -gt 0; if($busy){'busy'}else{'idle'}`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    try {
      const { stdout } = await execFileAsync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 15000, maxBuffer: 1024 });
      return stdout.trim() !== 'idle';
    } catch { return true; }
  }
  for (const site of ['chatgpt', 'zai', 'qwen', 'deepseek']) {
    for (const lock of ['SingletonLock', 'SingletonSocket']) {
      try { await fs.lstat(path.join(directory, 'browsers', site, lock)); return true; } catch (error) { if (error.code !== 'ENOENT') return true; }
    }
  }
  return false;
}

async function inventory(root, relative = '', state = { count: 0, bytes: 0 }) {
  await noLinks(path.join(root, relative));
  const files = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    if (++state.count > 200000) throw new Error('Saved website data contains too many files.');
    const name = path.join(relative, entry.name), absolute = path.join(root, name), stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error('Saved website data contains a linked file.');
    if (disposable.has(entry.name) || /^Singleton(?:Lock|Cookie|Socket)$/.test(entry.name)) continue;
    if (stat.isDirectory()) files.push(...await inventory(root, name, state));
    else if (stat.isFile()) {
      state.bytes += stat.size;
      if (state.bytes > 2 * 1024 * 1024 * 1024 || stat.size > 256 * 1024 * 1024) throw new Error('Saved website data exceeds the migration limit.');
      files.push({ relative: name, size: stat.size, modified: stat.mtimeMs });
    } else throw new Error('Saved website data contains an unsupported file.');
  }
  return files;
}

const hashFile = async filename => {
  const hash = createHash('sha256'), handle = await fs.open(filename, 'r');
  try { for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk); }
  finally { await handle.close(); }
  return hash.digest('hex');
};

/** Copy private profiles only after their browsers/service release them. The original is retained. */
export async function prepareWebsiteData({ destination, sources = [], isBusy = websiteDataBusy, recover = false } = {}) {
  destination = path.resolve(destination);
  await noLinks(destination, { missing: true });
  let damagedDestination = false;
  try {
    await validConfig(destination);
    return { dataDir: destination, status: 'ready', message: 'Saved website sessions use the permanent application folder.' };
  } catch (error) {
    if (error.code !== 'ENOENT') damagedDestination = true;
  }
  let source;
  for (const candidate of [...new Set(sources.filter(Boolean).map(value => path.resolve(value)))]) {
    if (same(candidate, destination) || path.basename(candidate) !== '.data' || path.basename(path.dirname(candidate)) !== 'Gravity-Web2API') continue;
    try { await validConfig(candidate); source = candidate; break; } catch { /* Only recognized valid legacy data is admitted. */ }
  }
  if (!source) return { dataDir: destination, status: damagedDestination ? 'error' : 'ready', message: damagedDestination
    ? 'The permanent website configuration needs recovery. Restore your retained original setup before retrying.' : 'New website sessions will use the permanent application folder.' };
  if (damagedDestination && !recover) return { dataDir: source, status: 'error', message: 'The permanent website data needs recovery. Your retained original is active; choose Migrate saved website data to retry safely.' };
  if (await isBusy(source)) return { dataDir: source, status: 'pending', message: 'Saved website data is still in use. Close its separate browsers and stop its service, then choose Migrate saved data.' };
  const parent = path.dirname(destination), stage = path.join(parent, `.gravity-web2api-migration-${randomUUID()}`);
  try {
    await fs.mkdir(parent, { recursive: true }); await noLinks(parent);
    if (damagedDestination) {
      if (await isBusy(destination)) throw new Error('The permanent website data is still in use.');
      await noLinks(destination);
      const archive = path.join(parent, `.gravity-web2api-recovery-${randomUUID()}`);
      if (path.dirname(archive) !== parent || path.dirname(destination) !== parent) throw new Error('Recovery path is outside the application data folder.');
      await fs.rename(destination, archive);
    } else {
      try { if ((await fs.readdir(destination)).length === 0) await fs.rmdir(destination); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await fs.mkdir(stage, { mode: 0o700 });
    const files = await inventory(source);
    for (const file of files) {
      const from = path.join(source, file.relative), to = path.join(stage, file.relative);
      await noLinks(from);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
      const after = await fs.lstat(from);
      if (after.size !== file.size || after.mtimeMs !== file.modified || await hashFile(from) !== await hashFile(to)) throw new Error('Website data changed while being copied.');
    }
    if (await isBusy(source)) throw new Error('The website browser or service reopened during migration.');
    const again = await inventory(source);
    if (JSON.stringify(again) !== JSON.stringify(files)) throw new Error('Website data changed during migration.');
    await validConfig(stage);
    await fs.writeFile(path.join(stage, 'gravity-migration.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), retainedOriginal: true }), { flag: 'wx', mode: 0o600 });
    await noLinks(destination, { missing: true });
    try { await fs.lstat(destination); throw new Error('The destination appeared during migration.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(stage, destination);
    return { dataDir: destination, status: 'migrated', message: 'Saved website data moved to the permanent application folder. The original remains available for rollback.' };
  } catch {
    // A partial copy stays in a uniquely named, application-owned staging folder;
    // it is never selected as a live profile. Retry uses a new staging folder.
    return { dataDir: source, status: 'error', message: 'Website data could not be migrated safely. The original remains active; close its browsers and service and retry.' };
  }
}
