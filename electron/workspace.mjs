import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
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
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { throw new Error('This file is not UTF-8 text.'); }
}

const revisionOf = content => createHash('sha256').update(content, 'utf8').digest('hex');
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const versionOf = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
const sameVersion = (left, right) => left && right && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => left[key] === right[key]);

async function boundedText(file, maximum) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Stored edit records must be regular files.');
  if (before.size > maximum) throw new Error('Stored edit record exceeds its size limit.');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) throw new Error('Stored edit record changed while opening.');
    const buffer = Buffer.alloc(maximum + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break; length += bytesRead;
    }
    if (length > maximum) throw new Error('Stored edit record exceeds its size limit.');
    return textBuffer(buffer.subarray(0, length));
  } finally { await handle.close(); }
}

async function toolOnPath(name) {
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      try { if ((await fs.stat(path.join(directory, name + suffix))).isFile()) return true; } catch { /* Try another PATH entry. */ }
    }
  }
  return false;
}

async function settleCommands(commands) {
  const results = await Promise.allSettled(commands);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results.map(result => result.value);
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
    this.maxContextBytes = options.maxContextBytes ?? 40_000;
    this.maxContextLines = options.maxContextLines ?? 500;
    this.resolveTool = options.resolveTool ?? toolOnPath;
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
      const content = textBuffer(buffer.subarray(0, length));
      return { path: parts.join('/'), content, revision: revisionOf(content) };
    } finally { await handle.close(); }
  }

  async write(root, relative, content, original, provenance = {}) {
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > this.maxFileBytes)
      throw new Error(`File content must be text of at most ${this.maxFileBytes} bytes.`);
    if (content.includes('\0')) throw new Error('Binary content cannot be written by the text editor.');
    if (original !== undefined && typeof original !== 'string') throw new Error('Original file content must be text.');
    if (!provenance || typeof provenance !== 'object' || !['editor', 'agent'].includes(provenance.source ?? 'editor')) throw new Error('Choose a valid edit source.');
    if (provenance.source === 'agent' && (typeof provenance.conversationId !== 'string' || !provenance.conversationId.trim() || provenance.conversationId.length > 200 || provenance.conversationId.includes('\0'))) throw new Error('Agent edits require a conversation identifier.');
    const canonical = await canonicalRoot(root);
    const parts = relativeParts(relative);
    if (!parts.length) throw new Error('Select a file to write.');
    const target = pathKey(path.join(canonical, ...parts));
    // Serialize app-owned writes so two approvals cannot both replace the same revision.
    const previous = this.writeQueues.get(target) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this._write(canonical, parts, content, original, provenance));
    this.writeQueues.set(target, operation);
    try { return await operation; }
    finally { if (this.writeQueues.get(target) === operation) this.writeQueues.delete(target); }
  }

  async _write(canonical, parts, content, original, provenance = {}) {
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
    const edit = provenance.source === 'agent' ? { version: 1, id: randomUUID(), path: parts.join('/'), source: 'agent', conversationId: provenance.conversationId,
      savedAt: new Date().toISOString(), state: 'prepared', original: before?.content ?? null, modified: content,
      originalRevision: before ? revisionOf(before.content) : null, modifiedRevision: revisionOf(content) } : null;
    if (edit) await this._storeEdit(canonical, edit);
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
      if (edit) {
        edit.state = 'applied'; edit.fileVersion = versionOf(await fs.lstat(target));
        await this._storeEdit(canonical, edit);
        await this._privateJson(canonical, ['agent-edits', 'latest', `${revisionOf(pathKey(edit.path))}.json`], { id: edit.id, path: edit.path, savedAt: edit.savedAt });
      }
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return { path: parts.join('/'), content, revision: revisionOf(content) };
  }

  async _privateJson(canonical, parts, value) {
    const parent = await ensureDirectories(canonical, [INTERNAL, ...parts.slice(0, -1)]);
    const target = await scoped(canonical, [INTERNAL, ...parts], { allowMissing: true });
    try { if (!(await fs.lstat(target)).isFile()) throw new Error('Stored edit metadata must be a regular file.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = path.join(parent, `.edit-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = null;
      await scoped(canonical, [INTERNAL, ...parts], { allowMissing: true }); await fs.rename(temporary, target);
    } finally { await handle?.close(); await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }

  _storeEdit(canonical, edit) { return this._privateJson(canonical, ['agent-edits', 'records', `${edit.id}.json`], edit); }

  async _recentEdits(canonical) {
    let directory;
    try { directory = await scoped(canonical, [INTERNAL, 'agent-edits', 'latest']); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const entries = []; let count = 0;
    for await (const entry of await fs.opendir(directory)) {
      if (++count > this.maxEntries) throw new Error('Saved edit index exceeds its entry limit.');
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) throw new Error('Saved edit index contains an unsupported entry.');
      const file = await scoped(canonical, [INTERNAL, 'agent-edits', 'latest', entry.name]);
      let record; try { record = JSON.parse(await boundedText(file, 8192)); } catch { throw new Error('Saved edit index could not be read safely.'); }
      if (typeof record?.path !== 'string' || typeof record.savedAt !== 'string') continue;
      const relative = relativeParts(record.path).join('/');
      if (!relative || revisionOf(pathKey(relative)) + '.json' !== entry.name) throw new Error('Saved edit index contains an invalid path.');
      entries.push({ path: relative, savedAt: record.savedAt });
    }
    return entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt)).slice(0, 50);
  }

  async _lastEdit(canonical, relative) {
    let index;
    try {
      const file = await scoped(canonical, [INTERNAL, 'agent-edits', 'latest', `${revisionOf(pathKey(relative))}.json`]);
      index = JSON.parse(await boundedText(file, 8192));
    } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Saved edit metadata could not be read safely.'); }
    if (!index || typeof index.id !== 'string' || !/^[a-f0-9-]{36}$/.test(index.id) || typeof index.path !== 'string' || pathKey(index.path) !== pathKey(relative)) throw new Error('Saved edit metadata is invalid.');
    const file = await scoped(canonical, [INTERNAL, 'agent-edits', 'records', `${index.id}.json`]);
    let edit;
    try { edit = JSON.parse(await boundedText(file, this.maxFileBytes * 12 + 16_384)); } catch { throw new Error('Saved agent edit could not be read safely.'); }
    if (!edit || edit.version !== 1 || edit.id !== index.id || typeof edit.path !== 'string' || pathKey(edit.path) !== pathKey(relative) || edit.source !== 'agent' || !['prepared', 'applied', 'undone'].includes(edit.state)
      || typeof edit.modified !== 'string' || Buffer.byteLength(edit.modified) > this.maxFileBytes || edit.modified.includes('\0') || revisionOf(edit.modified) !== edit.modifiedRevision
      || (edit.original === null ? edit.originalRevision !== null : typeof edit.original !== 'string' || Buffer.byteLength(edit.original) > this.maxFileBytes || edit.original.includes('\0') || revisionOf(edit.original) !== edit.originalRevision)
      || typeof edit.conversationId !== 'string' || !edit.conversationId.trim() || edit.conversationId.length > 200 || edit.conversationId.includes('\0') || typeof edit.savedAt !== 'string' || !Number.isFinite(Date.parse(edit.savedAt))
      || (edit.state !== 'prepared' && !['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => Number.isFinite(edit.fileVersion?.[key])))) throw new Error('Saved agent edit failed its content checks.');
    return edit;
  }

  async context(root, relative, { startLine = 1, endLine } = {}) {
    const file = await this.read(root, relative);
    const lines = file.content.split(/\r?\n/);
    if (!Number.isInteger(startLine) || startLine < 1 || startLine > lines.length) throw new Error('Choose a valid starting line in the saved file.');
    const end = endLine ?? Math.min(lines.length, startLine + this.maxContextLines - 1);
    if (!Number.isInteger(end) || end < startLine || end > lines.length || end - startLine + 1 > this.maxContextLines) throw new Error(`Choose at most ${this.maxContextLines} saved-file lines.`);
    const content = lines.slice(startLine - 1, end).join('\n');
    if (Buffer.byteLength(content, 'utf8') > this.maxContextBytes) throw new Error(`This selection exceeds ${this.maxContextBytes.toLocaleString()} bytes. Choose fewer lines.`);
    return { path: file.path, label: `${file.path}:${startLine}${end !== startLine ? `–${end}` : ''}`, content, startLine, endLine: end, revision: file.revision };
  }

  async review(root, relative) {
    const canonical = await canonicalRoot(root); const parts = relativeParts(relative);
    if (!parts.length) throw new Error('Choose a file to review.');
    const normalized = parts.join('/'); const target = await scoped(canonical, parts, { allowMissing: true });
    let current = null, currentVersion;
    try { current = await this.read(canonical, normalized); currentVersion = versionOf(await fs.lstat(target)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const edit = await this._lastEdit(canonical, normalized);
    let agent;
    if (edit) {
      const unchanged = current && current.content === edit.modified && current.revision === edit.modifiedRevision && sameVersion(currentVersion, edit.fileVersion);
      const canUndo = edit.state === 'applied' && !!unchanged;
      agent = { id: edit.id, conversationId: edit.conversationId, savedAt: edit.savedAt, isNew: edit.original === null, original: edit.original ?? '', modified: edit.modified, canUndo,
        undone: edit.state === 'undone', ...(canUndo ? {} : { reason: edit.state === 'undone' ? 'This agent edit has already been undone.' : 'The file changed after this agent edit. Undo will not replace newer changes.' }) };
    }
    const options = { cwd: canonical, windowsHide: true, timeout: 15_000, maxBuffer: this.maxOutputBytes, encoding: 'utf8' };
    const command = (args, overrides = {}) => execFileAsync('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], { ...options, ...overrides });
    let git = { available: false, status: '', original: '', modified: current?.content ?? '', diff: '' };
    try {
      const { stdout: prefix } = await command(['rev-parse', '--show-prefix']);
      const [{ stdout: status }, { stdout: diff }, { stdout: staged }] = await settleCommands([
        command(['status', '--short', '--', normalized]), command(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--', normalized]), command(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-renames', '--', normalized])
      ]);
      let original = '', hasCommit = true;
      try { await command(['rev-parse', '--verify', '--quiet', 'HEAD']); } catch (error) { if (error.code === 1) hasCommit = false; else throw error; }
      if (hasCommit) {
        const { stdout: tree } = await command(['ls-tree', '-z', 'HEAD', '--', normalized]);
        if (tree) {
          if (!/^[0-7]{6} blob [a-f0-9]{40,64}\t/.test(tree)) throw new Error('Git baseline is not a regular text file.');
          const { stdout: buffer } = await command(['show', `HEAD:${prefix.replace(/\r?\n$/, '')}${normalized}`], { encoding: 'buffer', maxBuffer: this.maxFileBytes });
          original = textBuffer(buffer);
        }
      }
      git = { available: true, status, original, modified: current?.content ?? '', diff: [diff, staged].filter(Boolean).join('\n') };
    } catch (error) {
      git.status = error.code === 'ENOENT' ? 'Git is not installed or is not on PATH.' : /not a git repository/i.test(error.stderr ?? '') ? 'This project is not a Git repository.' : 'Git inspection is unavailable for this file.';
    }
    return { path: normalized, content: current?.content ?? '', revision: current?.revision ?? null, git, ...(agent ? { agent } : {}) };
  }

  async undo(root, relative) {
    const canonical = await canonicalRoot(root); const parts = relativeParts(relative);
    if (!parts.length) throw new Error('Choose a file to undo.');
    const target = pathKey(path.join(canonical, ...parts)); const previous = this.writeQueues.get(target) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const normalized = parts.join('/'); const edit = await this._lastEdit(canonical, normalized);
      if (!edit || edit.state !== 'applied') throw new Error('There is no completed agent edit to undo for this file.');
      const current = await this.read(canonical, normalized); const file = await scoped(canonical, parts);
      if (current.content !== edit.modified || current.revision !== edit.modifiedRevision || !sameVersion(versionOf(await fs.lstat(file)), edit.fileVersion)) throw new Error('The file changed after this agent edit. Undo will not replace newer changes.');
      if (edit.original === null) {
        const directory = await ensureDirectories(canonical, [INTERNAL, 'backups']); const preserved = path.join(directory, `${Date.now()}-${randomUUID()}-undone-file.txt`);
        await scoped(canonical, parts); await fs.rename(file, preserved);
        // Keep the removed file as a protected backup. If an external save raced
        // the move, restore only into a missing path; never overwrite a new file.
        let preservedMatches = false;
        try { preservedMatches = revisionOf(await boundedText(preserved, this.maxFileBytes)) === edit.modifiedRevision; } catch { /* A racing binary or oversized save must be restored too. */ }
        if (!preservedMatches) {
          await scoped(canonical, parts, { allowMissing: true }).then(target => fs.copyFile(preserved, target, constants.COPYFILE_EXCL)).catch(() => {});
          throw new Error('The file changed during Undo. A preserved copy remains in the project backups.');
        }
        edit.preservedPath = path.relative(canonical, preserved).replaceAll('\\', '/');
      } else await this._write(canonical, parts, edit.original, edit.modified);
      edit.state = 'undone'; edit.undoneAt = new Date().toISOString(); await this._storeEdit(canonical, edit);
      return { path: normalized, content: edit.original ?? '', revision: edit.originalRevision, deleted: edit.original === null, editId: edit.id };
    });
    this.writeQueues.set(target, operation);
    try { return await operation; } finally { if (this.writeQueues.get(target) === operation) this.writeQueues.delete(target); }
  }

  async guide(root) {
    const canonical = await canonicalRoot(root); const entries = await this.list(canonical);
    const files = entries.filter(entry => entry.type === 'file'); const names = new Map(files.map(entry => [entry.name.toLowerCase(), entry.path]));
    const detected = [], commands = [], notes = [], tools = new Map();
    const available = async name => { if (!tools.has(name)) tools.set(name, { name, available: !!(await this.resolveTool(name)) }); return tools.get(name).available; };
    const add = async (label, command, source, tool, detail) => {
      if (commands.length >= 30 || command.length > 2000 || commands.some(item => item.command === command)) return;
      commands.push({ label, command, source, tool, available: await available(tool), ...(detail ? { detail } : {}) });
    };
    const read = async name => { if (!names.has(name.toLowerCase())) return null; try { return (await this.read(canonical, names.get(name.toLowerCase()))).content; } catch { notes.push(`${name} could not be read as bounded UTF-8 text.`); return null; } };
    const packageText = await read('package.json');
    if (packageText) {
      try {
        const pkg = JSON.parse(packageText); detected.push('Node.js');
        const manager = typeof pkg.packageManager === 'string' && /^(pnpm|yarn|bun)@/.test(pkg.packageManager) ? pkg.packageManager.split('@')[0] : names.has('pnpm-lock.yaml') ? 'pnpm' : names.has('yarn.lock') ? 'yarn' : names.has('bun.lock') || names.has('bun.lockb') ? 'bun' : 'npm';
        await available('node');
        await add('Install dependencies', `${manager} ${manager === 'npm' && names.has('package-lock.json') ? 'ci' : 'install'}`, 'package.json', manager);
        const scripts = pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts : {};
        for (const name of ['dev', 'start', 'build', 'test', ...Object.keys(scripts).filter(name => /^(test|check|lint):/.test(name))]) {
          if (typeof scripts[name] === 'string' && /^[A-Za-z0-9:_-]{1,100}$/.test(name)) await add(name === 'dev' || name === 'start' ? 'Run project' : name === 'build' ? 'Build project' : `Run ${name}`, `${manager} run ${name}`, `package.json → scripts.${name}`, manager, scripts[name].slice(0, 2000));
        }
      } catch { notes.push('package.json is not valid JSON. Review it before choosing a command.'); }
    }
    if (names.has('pyproject.toml') || names.has('requirements.txt') || names.has('manage.py')) {
      detected.push('Python'); const python = await available('python') ? 'python' : await available('python3') ? 'python3' : 'python';
      if (names.has('requirements.txt')) await add('Install Python dependencies', `${python} -m pip install -r requirements.txt`, 'requirements.txt', python);
      if (names.has('pyproject.toml')) await add('Install Python project', `${python} -m pip install -e .`, 'pyproject.toml', python);
      if (names.has('manage.py')) await add('Run Django server', `${python} manage.py runserver`, 'manage.py', python);
      const pyproject = await read('pyproject.toml'); if (/pytest/.test(pyproject || '') || entries.some(entry => entry.name === 'tests' && entry.type === 'directory')) await add('Run Python tests', `${python} -m pytest`, 'Python project/tests', python);
    }
    if (names.has('go.mod')) { detected.push('Go'); await add('Build Go project', 'go build ./...', 'go.mod', 'go'); await add('Run Go tests', 'go test ./...', 'go.mod', 'go'); if (names.has('main.go')) await add('Run Go project', 'go run .', 'main.go', 'go'); }
    const cargo = await read('Cargo.toml');
    if (cargo !== null) { detected.push('Rust'); await add('Build Rust project', 'cargo build', 'Cargo.toml', 'cargo'); await add('Run Rust tests', 'cargo test', 'Cargo.toml', 'cargo');
      const hasMain = await scoped(canonical, ['src', 'main.rs']).then(file => fs.stat(file).then(stat => stat.isFile())).catch(() => false); if (hasMain || /\[\[bin\]\]/.test(cargo)) await add('Run Rust project', 'cargo run', 'Cargo.toml/src/main.rs', 'cargo'); }
    const dotnet = files.find(file => /\.(?:sln|csproj|fsproj)$/i.test(file.name));
    if (dotnet) { detected.push('.NET'); await add('Build .NET project', 'dotnet build', dotnet.path, 'dotnet'); await add('Run .NET tests', 'dotnet test', dotnet.path, 'dotnet'); if (/\.(?:csproj|fsproj)$/i.test(dotnet.name)) await add('Run .NET project', `dotnet run --project '${dotnet.path.replaceAll("'", "''")}'`, dotnet.path, 'dotnet'); }
    if (names.has('pom.xml')) { detected.push('Maven/Java'); await available('java'); await add('Build Maven project', 'mvn package', 'pom.xml', 'mvn'); await add('Run Maven tests', 'mvn test', 'pom.xml', 'mvn'); }
    const makefile = await read('Makefile');
    if (makefile) for (const match of makefile.matchAll(/^(run|dev|start|test|check|build)\s*:/gm)) await add(`Run ${match[1]} target`, `make ${match[1]}`, 'Makefile', 'make');
    const readme = files.find(file => /^readme(?:\.(?:md|txt|rst))?$/i.test(file.name));
    if (readme) {
      const text = await read(readme.name); let fenced = false;
      for (const [index, line] of (text || '').split(/\r?\n/).entries()) {
        if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
        if (!fenced) continue;
        const command = line.trim().replace(/^(?:\$|PS>)\s*/, '');
        const match = /^(npm|pnpm|yarn|bun|node|python3?|py|go|cargo|dotnet|mvn|gradle|make|composer|php)\s+/.exec(command);
        if (match && !/[\x00-\x1f]/.test(command) && !/^(?:npm|pnpm|yarn|bun)\s+(?:create|init)\b/.test(command)) await add('Documented command', command, `${readme.path}:${index + 1}`, match[1]);
      }
    }
    if (!commands.length) notes.push('No recognized run or test commands were found. Check the project README.');
    notes.push('Commands are shown for review and run only when you choose Run. Tool availability means the executable is on PATH; project dependencies may still need installation.');
    return { detected: [...new Set(detected)], commands, tools: [...tools.values()], notes };
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
    const agentFiles = await this._recentEdits(canonical);
    const options = { cwd: canonical, windowsHide: true, timeout: 15_000, maxBuffer: this.maxOutputBytes, encoding: 'utf8' };
    const command = args => execFileAsync('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], options);
    try {
      // Pathspecs keep status and patches scoped to the selected project directory.
      const [{ stdout: branch }, { stdout: status }, { stdout: diff }, { stdout: staged }, { stdout: rawStatus }, { stdout: prefix }] = await settleCommands([
        command(['branch', '--show-current']),
        command(['status', '--short', '--', '.']),
        command(['diff', '--no-ext-diff', '--no-textconv', '--', '.']),
        command(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--', '.']),
        command(['status', '--porcelain=v1', '--untracked-files=all', '-z', '--', '.']), command(['rev-parse', '--show-prefix'])
      ]);
      const files = [], records = rawStatus.split('\0'); const projectPrefix = prefix.replace(/\r?\n$/, '');
      for (let index = 0; index < records.length; index++) {
        const record = records[index]; if (!record) continue;
        const status = record.slice(0, 2); let relative = record.slice(3);
        if (/[RC]/.test(status)) index++;
        if (projectPrefix) { if (!relative.startsWith(projectPrefix)) continue; relative = relative.slice(projectPrefix.length); }
        try { relative = relativeParts(relative).join('/'); } catch { continue; }
        if (relative && !relative.endsWith('/')) files.push({ path: relative, status });
      }
      return { branch: branch.trim() || '(detached HEAD)', status, diff: [diff, staged ? `\n--- Staged changes ---\n${staged}` : ''].join(''), files, agentFiles };
    } catch (error) {
      if (error.code === 'ENOENT') return { branch: '', status: 'Git is not installed or is not on PATH.', diff: '', files: [], agentFiles };
      if (/not a git repository/i.test(error.stderr ?? '')) return { branch: '', status: 'This project is not a Git repository.', diff: '', files: [], agentFiles };
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
