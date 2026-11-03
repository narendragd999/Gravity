import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';

const execFileAsync = promisify(execFile);
const EXCLUDED = new Set(['.git', 'node_modules', '.antigravity', 'dist', 'build', '.next', 'vendor']);
const INTERNAL = '.antigravity';

function relativeParts(relative = '') {
  if (typeof relative !== 'string' || relative.includes('\0') || relative.length > 4096)
    throw new Error('A valid relative workspace path is required.');
  if (path.win32.isAbsolute(relative) || path.posix.isAbsolute(relative) || relative.includes(':'))
    throw new Error('Workspace paths must be relative to the selected project.');
  const parts = relative.replaceAll('\\', '/').split('/').filter(part => part !== '' && part !== '.');
  if (parts.some(part => part === '..' || /[. ]$/.test(part) || /[<>"|?*\x00-\x1f]/.test(part)))
    throw new Error('Workspace path traversal or unsupported path component.');
  if (parts.some(part => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
    throw new Error('Reserved device paths are not workspace files.');
  if (parts[0]?.toLowerCase() === INTERNAL)
    throw new Error('Internal workspace backups are protected.');
  return parts;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('Path escapes the selected workspace.');
}

async function canonicalRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root))
    throw new Error('An absolute project directory is required.');
  const canonical = await fs.realpath(root);
  if (!(await fs.stat(canonical)).isDirectory()) throw new Error('Project path is not a directory.');
  return canonical;
}

async function scoped(root, parts, { allowMissing = false } = {}) {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    inside(root, current);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (allowMissing && error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('Symbolic links and directory junctions are not allowed in workspace operations.');
    const canonical = await fs.realpath(current);
    inside(root, canonical);
    // Windows directory reparse redirects that lstat does not expose are refused too.
    if (path.relative(current, canonical) !== '')
      throw new Error('Redirected workspace paths are not allowed.');
  }
  return current;
}

async function ensureDirectories(root, parts) {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await scoped(root, path.relative(root, current).split(path.sep));
    if (!(await fs.stat(current)).isDirectory()) throw new Error('A parent path is not a directory.');
  }
  return current;
}

function textBuffer(buffer) {
  if (buffer.includes(0)) throw new Error('Binary files cannot be opened in the text editor.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error('This file is not UTF-8 text.'); }
}

export class WorkspaceService {
  constructor(options = {}) {
    this.maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
    this.maxEntries = options.maxEntries ?? 5000;
    this.maxSearchResults = options.maxSearchResults ?? 200;
    this.maxSearchBytes = options.maxSearchBytes ?? 32 * 1024 * 1024;
    this.maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.writeQueues = new Map();
  }

  async list(root, relative = '') {
    const canonical = await canonicalRoot(root);
    const parts = relativeParts(relative);
    const directory = await scoped(canonical, parts);
    const entries = [];
    for await (const entry of await fs.opendir(directory)) {
      if (entries.length >= this.maxEntries) throw new Error(`Directory exceeds the ${this.maxEntries} entry limit.`);
      entries.push(entry);
    }
    return entries.filter(entry => !EXCLUDED.has(entry.name.toLowerCase()) && !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()))
      .map(entry => ({ name: entry.name, path: [...parts, entry.name].join('/'), type: entry.isDirectory() ? 'directory' : 'file' }))
      .sort((a, b) => (a.type === b.type ? 0 : a.type === 'directory' ? -1 : 1) || a.name.localeCompare(b.name));
  }

  async read(root, relative) {
    const canonical = await canonicalRoot(root);
    const parts = relativeParts(relative);
    if (!parts.length) throw new Error('Select a file to read.');
    const file = await scoped(canonical, parts);
    const before = await fs.lstat(file);
    if (!before.isFile()) throw new Error('Only regular text files can be read.');
    if (before.size > this.maxFileBytes) throw new Error(`File exceeds the ${this.maxFileBytes} byte editor limit.`);
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino)
        throw new Error('File changed while being opened. Retry the read.');
      const buffer = Buffer.alloc(this.maxFileBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > this.maxFileBytes) throw new Error(`File exceeds the ${this.maxFileBytes} byte editor limit.`);
      return { path: parts.join('/'), content: textBuffer(buffer.subarray(0, length)) };
    } finally { await handle.close(); }
  }

  async write(root, relative, content, original) {
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > this.maxFileBytes)
      throw new Error(`File content must be text of at most ${this.maxFileBytes} bytes.`);
    if (content.includes('\0')) throw new Error('Binary content cannot be written by the text editor.');
    if (original !== undefined && typeof original !== 'string') throw new Error('Original file content must be text.');
    const canonical = await canonicalRoot(root);
    const parts = relativeParts(relative);
    if (!parts.length) throw new Error('Select a file to write.');
    const target = path.join(canonical, ...parts);
    // Serialize app-owned writes so two approvals cannot both replace the same revision.
    const previous = this.writeQueues.get(target) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this._write(canonical, parts, content, original));
    this.writeQueues.set(target, operation);
    try { return await operation; }
    finally { if (this.writeQueues.get(target) === operation) this.writeQueues.delete(target); }
  }

  async _write(canonical, parts, content, original) {
    const target = await scoped(canonical, parts, { allowMissing: true });
    let before = null;
    let mode;
    try {
      before = await this.read(canonical, parts.join('/'));
      mode = (await fs.stat(target)).mode;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (original !== undefined && (before?.content ?? '') !== original)
      throw new Error('File changed since it was read. Reload and review before saving.');
    const parent = await ensureDirectories(canonical, parts.slice(0, -1));
    if (before) {
      const backupDirectory = await ensureDirectories(canonical, [INTERNAL, 'backups']);
      const backupName = `${Date.now()}-${randomUUID()}.json`;
      await fs.writeFile(path.join(backupDirectory, backupName), JSON.stringify({ path: parts.join('/'), savedAt: new Date().toISOString(), content: before.content }, null, 2), { flag: 'wx', mode: 0o600 });
    }
    const temporary = path.join(parent, `.antigravity-save-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, content, { flag: 'wx', mode: mode ?? 0o600 });
      await scoped(canonical, parts, { allowMissing: true });
      // Detect an external editor change that happened while we prepared the write.
      let current = null;
      try { current = await this.read(canonical, parts.join('/')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if ((current?.content ?? null) !== (before?.content ?? null))
        throw new Error('File changed while saving. Reload and review before saving.');
      await fs.rename(temporary, target);
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return { path: parts.join('/'), content };
  }

  async search(root, query) {
    if (typeof query !== 'string' || !query.trim() || query.length > 2000)
      throw new Error('Search requires 1–2000 characters.');
    const canonical = await canonicalRoot(root);
    const needle = query.toLocaleLowerCase();
    const results = [];
    let examined = 0;
    let bytes = 0;
    const directories = [''];
    while (directories.length && examined < this.maxEntries && bytes < this.maxSearchBytes && results.length < this.maxSearchResults) {
      const relative = directories.shift();
      let entries;
      try { entries = await this.list(canonical, relative); }
      catch (error) { if (['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) continue; throw error; }
      for (const entry of entries) {
        if (++examined > this.maxEntries || bytes >= this.maxSearchBytes || results.length >= this.maxSearchResults) break;
        if (entry.type === 'directory') { directories.push(entry.path); continue; }
        let file;
        try { file = await this.read(canonical, entry.path); } catch { continue; }
        bytes += Buffer.byteLength(file.content, 'utf8');
        const lines = file.content.split(/\r?\n/);
        for (let i = 0; i < lines.length && results.length < this.maxSearchResults; i++)
          if (lines[i].toLocaleLowerCase().includes(needle)) results.push({ path: entry.path, line: i + 1, text: lines[i].slice(0, 600) });
      }
    }
    return results;
  }

  async git(root) {
    const canonical = await canonicalRoot(root);
    const options = { cwd: canonical, windowsHide: true, timeout: 15_000, maxBuffer: this.maxOutputBytes, encoding: 'utf8' };
    const command = args => execFileAsync('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], options);
    try {
      // Pathspecs keep status and patches scoped to the selected project directory.
      const [{ stdout: branch }, { stdout: status }, { stdout: diff }, { stdout: staged }] = await Promise.all([
        command(['branch', '--show-current']),
        command(['status', '--short', '--', '.']),
        command(['diff', '--no-ext-diff', '--no-textconv', '--', '.']),
        command(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--', '.'])
      ]);
      return { branch: branch.trim() || '(detached HEAD)', status, diff: [diff, staged ? `\n--- Staged changes ---\n${staged}` : ''].join('') };
    } catch (error) {
      if (error.code === 'ENOENT') return { branch: '', status: 'Git is not installed or is not on PATH.', diff: '' };
      if (/not a git repository/i.test(error.stderr ?? '')) return { branch: '', status: 'This project is not a Git repository.', diff: '' };
      throw new Error(`Git inspection failed: ${(error.stderr || error.message).slice(0, 500)}`);
    }
  }

  run(root, command, { id = randomUUID(), onData = () => {}, onDone = () => {}, signal } = {}) {
    if (typeof command !== 'string' || !command.trim() || command.length > 32_000)
      throw new Error('A command of 1–32000 characters is required.');
    let child;
    let finished = false;
    let stopReason;
    let timer;
    let cleanupTimer;
    let output = '';
    let outputBytes = 0;
    let resolveDone;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const done = new Promise(resolve => { resolveDone = resolve; });
    const emit = text => {
      const available = this.maxOutputBytes - outputBytes;
      if (available <= 0) return;
      const encoded = Buffer.from(text);
      let accepted = encoded.subarray(0, available).toString('utf8');
      while (Buffer.byteLength(accepted) > available) accepted = accepted.slice(0, -1);
      outputBytes += Buffer.byteLength(accepted);
      output += accepted;
      try { onData(accepted); } catch { /* UI subscriber does not own process cleanup. */ }
    };
    const finish = code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', stop);
      const exitCode = stopReason === 'timeout' ? 124 : stopReason === 'output' ? 137 : stopReason ? 130 : (code ?? 1);
      const result = { exitCode, output };
      try { onDone(result); } catch { /* A detached renderer cannot prevent completion. */ }
      resolveDone(result);
    };
    const terminate = reason => {
      if (finished || stopReason) return;
      stopReason = reason;
      if (!child?.pid) return;
      if (process.platform === 'win32') {
        const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
        execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, error => {
          if (error && child.exitCode === null) child.kill();
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
      cleanupTimer = setTimeout(() => {
        child.stdout?.destroy(); child.stderr?.destroy();
        finish(null);
      }, 6000);
      cleanupTimer.unref?.();
    };
    const stop = () => terminate('cancelled');
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    Promise.resolve().then(async () => {
      const canonical = await canonicalRoot(root);
      if (stopReason) { finish(null); return; }
      const windows = process.platform === 'win32';
      const executable = windows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/sh';
      const args = windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ${command}`] : ['-c', command];
      child = spawn(executable, args, { cwd: canonical, windowsHide: true, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] });
      timer = setTimeout(() => { emit('\nCommand timed out.\n'); terminate('timeout'); }, this.timeoutMs);
      for (const stream of ['stdout', 'stderr']) {
        child[stream].on('data', chunk => {
          const text = decoders[stream].write(chunk);
          const exceedsLimit = Buffer.byteLength(text) >= this.maxOutputBytes - outputBytes;
          emit(text);
          if (exceedsLimit) terminate('output');
        });
        child[stream].on('end', () => emit(decoders[stream].end()));
      }
      child.on('error', error => { emit(`${error.message}\n`); finish(1); });
      child.on('close', code => finish(code));
    }).catch(error => { emit(`${error.message}\n`); finish(1); });
    return { id, stop, done };
  }
}
