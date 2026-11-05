import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { WorkspaceService } from '../electron/workspace.mjs';

const execFileAsync = promisify(execFile);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-workspace-test-'));
  t.after(async () => {
    const absolute = path.resolve(root);
    const parent = path.resolve(os.tmpdir());
    assert.equal(path.dirname(absolute), parent);
    assert.ok(path.basename(absolute).startsWith('antigravity-workspace-test-'));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  return root;
}

test('creates and edits UTF-8 files, preserves the previous version and lists directories first', async t => {
  const root = await fixture(t);
  const service = new WorkspaceService();
  await service.write(root, 'src/example.js', 'export const name = "world";\n');
  await service.write(root, 'README.md', '# Hello\n');
  const before = await service.read(root, 'src/example.js');
  await service.write(root, before.path, 'export const name = "earth 🌏";\n', before.content);
  assert.equal((await service.read(root, before.path)).content, 'export const name = "earth 🌏";\n');
  const listing = await service.list(root);
  assert.deepEqual(listing.map(entry => [entry.path, entry.type]), [['src', 'directory'], ['README.md', 'file']]);
  const backups = await fs.readdir(path.join(root, '.antigravity', 'backups'));
  assert.equal(backups.length, 1);
  const backup = JSON.parse(await fs.readFile(path.join(root, '.antigravity', 'backups', backups[0]), 'utf8'));
  assert.equal(backup.path, 'src/example.js');
  assert.equal(backup.content, before.content);
  await assert.rejects(service.read(root, `.antigravity/backups/${backups[0]}`), /protected/);
});

test('rejects traversal, absolute paths, alternate streams, reserved names and oversized or binary files', async t => {
  const root = await fixture(t);
  const service = new WorkspaceService({ maxFileBytes: 64 });
  for (const relative of ['../outside.txt', 'a/../../outside.txt', 'C:\\secret.txt', '\\\\server\\share', '/etc/passwd', 'file.txt:stream', 'file. ', 'CON.txt'])
    await assert.rejects(service.write(root, relative, 'no'), /path|relative|device/i);
  await fs.writeFile(path.join(root, 'binary.dat'), Buffer.from([1, 0, 2]));
  await fs.writeFile(path.join(root, 'invalid.txt'), Buffer.from([0xff, 0xff]));
  await fs.writeFile(path.join(root, 'large.txt'), 'x'.repeat(65));
  await assert.rejects(service.read(root, 'binary.dat'), /Binary/);
  await assert.rejects(service.read(root, 'invalid.txt'), /UTF-8/);
  await assert.rejects(service.read(root, 'large.txt'), /limit/);
  await assert.rejects(service.write(root, 'large.txt', 'x'.repeat(65)), /at most/);
});

test('rejects junction or symlink escapes for reading, listing, writing and backup storage', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside contents');
  try { await fs.symlink(outside, path.join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Creating test links is not permitted on this host.'); return; } throw error; }
  const service = new WorkspaceService();
  await assert.rejects(service.read(root, 'redirect/secret.txt'), /links|junctions|escapes|Redirected/);
  await assert.rejects(service.list(root, 'redirect'), /links|junctions|escapes|Redirected/);
  await assert.rejects(service.write(root, 'redirect/new.txt', 'no'), /links|junctions|escapes|Redirected/);
  assert.deepEqual(await service.list(root), []);
  await fs.writeFile(path.join(root, 'file.txt'), 'before');
  await fs.symlink(outside, path.join(root, '.antigravity'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(service.write(root, 'file.txt', 'after', 'before'), /links|junctions|escapes|Redirected/);
  assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'before');
  assert.deepEqual(await fs.readdir(outside), ['secret.txt']);
});

test('stale and concurrent edits cannot silently replace newer content', async t => {
  const root = await fixture(t);
  const service = new WorkspaceService();
  await service.write(root, 'file.txt', 'initial');
  await fs.writeFile(path.join(root, 'file.txt'), 'external edit');
  await assert.rejects(service.write(root, 'file.txt', 'stale edit', 'initial'), /changed since/);
  const edits = ['first write', 'second write'];
  const results = await Promise.allSettled(edits.map(content => service.write(root, 'file.txt', content, 'external edit')));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /changed since/);
  // Filesystem canonicalization may finish in either order before writes join the queue.
  const winningEdit = edits[results.findIndex(result => result.status === 'fulfilled')];
  assert.equal((await service.read(root, 'file.txt')).content, winningEdit);
});

test('literal search excludes dependencies and internal metadata and reports line numbers', async t => {
  const root = await fixture(t);
  const service = new WorkspaceService();
  await service.write(root, 'src/example.txt', 'top\nFind [me] here\nother');
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'node_modules', 'hidden.txt'), 'Find [me] here');
  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, '.git', 'hidden.txt'), 'Find [me] here');
  const results = await service.search(root, '[ME]');
  assert.deepEqual(results, [{ path: 'src/example.txt', line: 2, text: 'Find [me] here' }]);
  await assert.rejects(service.search(root, ''), /Search requires/);
});

test('git status and diff inspect the selected project without external diff execution', async t => {
  const root = await fixture(t);
  try { await execFileAsync('git', ['init', root], { windowsHide: true }); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('Git unavailable.'); return; } throw error; }
  await fs.writeFile(path.join(root, 'example.txt'), 'tracked\n');
  await execFileAsync('git', ['-C', root, 'add', 'example.txt'], { windowsHide: true });
  const result = await new WorkspaceService().git(root);
  assert.ok(result.branch);
  assert.match(result.status, /example\.txt/);
  assert.match(result.diff, /tracked/);
});

test('saved-file context is scoped, line-bounded and identifies the saved revision', async t => {
  const root = await fixture(t); const service = new WorkspaceService({ maxContextLines: 3, maxContextBytes: 20 });
  await service.write(root, 'code.txt', 'one\r\ntwo 😀\r\nthree\r\nfour');
  const context = await service.context(root, 'code.txt', { startLine: 2, endLine: 3 });
  assert.equal(context.content, 'two 😀\nthree'); assert.equal(context.startLine, 2); assert.equal(context.endLine, 3);
  assert.equal(context.path, 'code.txt'); assert.match(context.label, /code\.txt:2/);
  assert.equal(context.revision, createHash('sha256').update('one\r\ntwo 😀\r\nthree\r\nfour').digest('hex'));
  await assert.rejects(service.context(root, '../outside.txt'), /traversal|relative/);
  await assert.rejects(service.context(root, 'code.txt', { startLine: 0 }), /starting line/);
  await assert.rejects(service.context(root, 'code.txt', { startLine: 1, endLine: 4 }), /at most 3/);
  await service.write(root, 'long.txt', '😀'.repeat(8)); await assert.rejects(service.context(root, 'long.txt'), /bytes/);
  const defaultRange = await service.context(root, 'code.txt'); assert.equal(defaultRange.endLine, 3);
});

test('agent edit provenance survives restart and Undo restores only the latest unchanged edit', async t => {
  const root = await fixture(t); let service = new WorkspaceService();
  await service.write(root, 'file.txt', 'original\n');
  await service.write(root, 'file.txt', 'agent edit\n', 'original\n', { source: 'agent', conversationId: 'conversation-1' });
  service = new WorkspaceService();
  const review = await service.review(root, 'file.txt');
  assert.equal(review.agent.original, 'original\n'); assert.equal(review.agent.modified, 'agent edit\n'); assert.equal(review.agent.canUndo, true);
  assert.equal(review.agent.conversationId, 'conversation-1');
  const undone = await service.undo(root, 'file.txt'); assert.equal(undone.deleted, false); assert.equal(undone.content, 'original\n');
  assert.equal((await service.read(root, 'file.txt')).content, 'original\n');
  assert.equal((await service.review(root, 'file.txt')).agent.undone, true);
  await assert.rejects(service.undo(root, 'file.txt'), /no completed agent edit/);
  assert.equal((await service.git(root)).agentFiles[0].path, 'file.txt');
});

test('Undo refuses later external changes and editor saves even when their content matches', async t => {
  const root = await fixture(t); const service = new WorkspaceService();
  await service.write(root, 'file.txt', 'original');
  await service.write(root, 'file.txt', 'agent', 'original', { source: 'agent', conversationId: 'one' });
  await fs.writeFile(path.join(root, 'file.txt'), 'user change');
  await assert.rejects(service.undo(root, 'file.txt'), /newer changes/);
  assert.equal((await service.read(root, 'file.txt')).content, 'user change');
  await service.write(root, 'file.txt', 'second agent', 'user change', { source: 'agent', conversationId: 'two' });
  await service.write(root, 'file.txt', 'second agent', 'second agent');
  assert.equal((await service.review(root, 'file.txt')).agent.canUndo, false);
  await assert.rejects(service.undo(root, 'file.txt'), /newer changes/);
});

test('Undo of a new agent file removes only that unchanged file and preserves its contents in backups', async t => {
  const root = await fixture(t); const service = new WorkspaceService();
  await service.write(root, 'new/file.txt', 'new agent file 😀', '', { source: 'agent', conversationId: 'new-file' });
  assert.equal((await service.review(root, 'new/file.txt')).agent.isNew, true);
  const result = await service.undo(root, 'new/file.txt'); assert.equal(result.deleted, true);
  assert.equal(await fs.stat(path.join(root, 'new/file.txt')).then(() => true, () => false), false);
  const backup = (await fs.readdir(path.join(root, '.antigravity', 'backups'))).find(name => name.endsWith('-undone-file.txt'));
  assert.equal(await fs.readFile(path.join(root, '.antigravity', 'backups', backup), 'utf8'), 'new agent file 😀');
  await service.write(root, 'another.txt', '', '', { source: 'agent', conversationId: 'empty-new-file' });
  await fs.writeFile(path.join(root, 'another.txt'), 'later user content');
  await assert.rejects(service.undo(root, 'another.txt'), /newer changes/);
  assert.equal(await fs.readFile(path.join(root, 'another.txt'), 'utf8'), 'later user content');
});

test('new-file Undo restores a racing binary or oversized user save into a missing path', async t => {
  for (const userSave of [Buffer.from([255, 0, 13]), Buffer.alloc(257, 'x')]) {
    const root = await fixture(t); const service = new WorkspaceService({ maxFileBytes: 128 });
    await service.write(root, 'new.txt', 'agent file', '', { source: 'agent', conversationId: 'race-fixture' });
    const target = path.join(root, 'new.txt'); const rename = fs.rename;
    fs.rename = async (from, to) => { if (from === target && to.endsWith('-undone-file.txt')) await fs.writeFile(target, userSave); return rename(from, to); };
    try { await assert.rejects(service.undo(root, 'new.txt'), /changed during Undo/); } finally { fs.rename = rename; }
    assert.deepEqual(await fs.readFile(target), userSave);
    const backup = (await fs.readdir(path.join(root, '.antigravity', 'backups'))).find(name => name.endsWith('-undone-file.txt'));
    assert.deepEqual(await fs.readFile(path.join(root, '.antigravity', 'backups', backup)), userSave);
  }
});

test('agent provenance rejects corrupt content and linked metadata before Undo or save', async t => {
  const root = await fixture(t); const outside = await fixture(t); const service = new WorkspaceService();
  await service.write(root, 'file.txt', 'before');
  await service.write(root, 'file.txt', 'after', 'before', { source: 'agent', conversationId: 'one' });
  const directory = path.join(root, '.antigravity', 'agent-edits', 'records'); const name = (await fs.readdir(directory))[0];
  const record = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')); record.original = 'corrupted backup';
  await fs.writeFile(path.join(directory, name), JSON.stringify(record));
  await assert.rejects(service.undo(root, 'file.txt'), /content checks/); assert.equal((await service.read(root, 'file.txt')).content, 'after');
  const linkedRoot = await fixture(t); await fs.writeFile(path.join(linkedRoot, 'file.txt'), 'before');
  await fs.symlink(outside, path.join(linkedRoot, '.antigravity'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(service.write(linkedRoot, 'file.txt', 'after', 'before', { source: 'agent', conversationId: 'two' }), /links|junctions|Redirected/);
  assert.equal(await fs.readFile(path.join(linkedRoot, 'file.txt'), 'utf8'), 'before'); assert.deepEqual(await fs.readdir(outside), []);
});

test('per-file Git review preserves the committed baseline and excludes other files and enclosing projects', async t => {
  const root = await fixture(t); const service = new WorkspaceService();
  try { await execFileAsync('git', ['init', root], { windowsHide: true }); } catch (error) { if (error.code === 'ENOENT') { t.skip('Git unavailable.'); return; } throw error; }
  await service.write(root, 'project/file.txt', 'before\n'); await service.write(root, 'outside.txt', 'outside before\n');
  await execFileAsync('git', ['-C', root, 'add', '.'], { windowsHide: true });
  await execFileAsync('git', ['-C', root, '-c', 'user.name=Workspace Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture baseline'], { windowsHide: true });
  await service.write(root, 'project/file.txt', 'after\n'); await service.write(root, 'outside.txt', 'outside after\n');
  const selected = path.join(root, 'project'); const review = await service.review(selected, 'file.txt');
  assert.equal(review.git.available, true); assert.equal(review.git.original, 'before\n'); assert.equal(review.git.modified, 'after\n');
  assert.match(review.git.diff, /after/); assert.doesNotMatch(review.git.diff, /outside after/);
  assert.deepEqual((await service.git(selected)).files.map(file => file.path), ['file.txt']);
  await assert.rejects(service.review(selected, '../outside.txt'), /traversal/);
});

test('Git review retains full bounded text baselines and reports invalid baseline text', async t => {
  const root = await fixture(t); const service = new WorkspaceService({ maxOutputBytes: 512, maxFileBytes: 16_384 });
  try { await execFileAsync('git', ['init', root], { windowsHide: true }); } catch (error) { if (error.code === 'ENOENT') { t.skip('Git unavailable.'); return; } throw error; }
  const baseline = '\uFEFF' + 'a'.repeat(8192) + '\n'; await service.write(root, 'file.txt', baseline);
  const unborn = await service.review(root, 'file.txt'); assert.equal(unborn.git.available, true); assert.equal(unborn.git.original, '');
  await execFileAsync('git', ['-C', root, 'add', '--', 'file.txt'], { windowsHide: true });
  await execFileAsync('git', ['-C', root, '-c', 'user.name=Workspace Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'text fixture'], { windowsHide: true });
  const review = await service.review(root, 'file.txt'); assert.equal(review.git.available, true); assert.equal(review.git.original, baseline); assert.equal(review.git.modified, baseline);
  await fs.writeFile(path.join(root, 'binary.txt'), Buffer.from([0, 255, 13]));
  await execFileAsync('git', ['-C', root, 'add', '--', 'binary.txt'], { windowsHide: true });
  await execFileAsync('git', ['-C', root, '-c', 'user.name=Workspace Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'binary fixture'], { windowsHide: true });
  await fs.writeFile(path.join(root, 'binary.txt'), 'now text\n');
  const invalid = await service.review(root, 'binary.txt'); assert.equal(invalid.git.available, false); assert.match(invalid.git.status, /unavailable/); assert.equal(invalid.git.modified, 'now text\n');
});

test('project guide detects declared and documented commands and missing tools without running scripts', async t => {
  const root = await fixture(t); const service = new WorkspaceService({ resolveTool: async name => name === 'npm' });
  await service.write(root, 'package.json', JSON.stringify({ scripts: { dev: 'node should-not-run.js', build: 'build-command', test: 'test-command', 'test:unit': 'unit-command' } }));
  await service.write(root, 'package-lock.json', '{}');
  await service.write(root, 'README.md', '# Project\n```powershell\nnpm run dev\npython run_server.py\n```\n');
  await service.write(root, 'should-not-run.js', "require('node:fs').writeFileSync('executed.txt', 'not allowed')");
  const guide = await service.guide(root);
  assert.deepEqual(guide.detected, ['Node.js']); assert.ok(guide.commands.some(item => item.command === 'npm ci'));
  assert.ok(guide.commands.some(item => item.command === 'npm run test:unit' && item.detail === 'unit-command'));
  assert.ok(guide.commands.some(item => item.command === 'python run_server.py' && item.source === 'README.md:4' && !item.available));
  assert.equal(guide.commands.filter(item => item.command === 'npm run dev').length, 1);
  assert.ok(guide.tools.some(item => item.name === 'node' && !item.available));
  assert.equal(await fs.stat(path.join(root, 'executed.txt')).then(() => true, () => false), false);
});

test('project guide recognizes Python, Go and Rust manifests and keeps all tool checks passive', async t => {
  const root = await fixture(t); const checked = [];
  const service = new WorkspaceService({ resolveTool: async name => { checked.push(name); return false; } });
  await service.write(root, 'requirements.txt', 'pytest\n'); await service.write(root, 'pyproject.toml', '[tool.pytest.ini_options]\n');
  await service.write(root, 'go.mod', 'module fixture\n'); await service.write(root, 'main.go', 'package main\n');
  await service.write(root, 'Cargo.toml', '[package]\nname="fixture"\n'); await service.write(root, 'src/main.rs', 'fn main() {}\n');
  const guide = await service.guide(root);
  assert.deepEqual(guide.detected, ['Python', 'Go', 'Rust']);
  for (const command of ['python -m pip install -r requirements.txt', 'python -m pytest', 'go test ./...', 'go run .', 'cargo run']) assert.ok(guide.commands.some(item => item.command === command), command);
  assert.ok(guide.commands.every(item => !item.available)); assert.ok(checked.includes('cargo'));
});

test('command runner emits output and exit status from a real non-interactive shell', { timeout: 15_000 }, async t => {
  const root = await fixture(t);
  const chunks = [];
  const completions = [];
  const service = new WorkspaceService();
  const command = process.platform === 'win32' ? "Write-Output 'workspace-ready'; exit 7" : "printf 'workspace-ready'; exit 7";
  const run = service.run(root, command, { id: 'test-run', onData: chunk => chunks.push(chunk), onDone: result => completions.push(result) });
  assert.equal(run.id, 'test-run');
  const result = await run.done;
  assert.equal(result.exitCode, 7);
  assert.match(result.output, /workspace-ready/);
  assert.equal(chunks.join(''), result.output);
  assert.equal(completions.length, 1);
});

test('command runner cancels an active shell and honors a pre-aborted signal', { timeout: 15_000 }, async t => {
  const root = await fixture(t);
  const service = new WorkspaceService();
  const abort = new AbortController();
  const command = process.platform === 'win32' ? "Write-Output 'started'; Start-Sleep -Seconds 30" : "printf 'started'; sleep 30";
  const run = service.run(root, command, { signal: abort.signal, onData: chunk => { if (chunk.includes('started')) abort.abort(); } });
  assert.equal((await run.done).exitCode, 130);
  const stopped = service.run(root, command, { signal: AbortSignal.abort() });
  const stoppedResult = await stopped.done;
  assert.equal(stoppedResult.exitCode, 130);
  assert.equal(stoppedResult.output, '');
});

test('command runner bounds time and output', { timeout: 15_000 }, async t => {
  const root = await fixture(t);
  const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
  const timed = new WorkspaceService({ timeoutMs: 200 });
  assert.equal((await timed.run(root, command).done).exitCode, 124);
  const loud = new WorkspaceService({ maxOutputBytes: 128 });
  const loudCommand = process.platform === 'win32' ? "Write-Output ('x' * 10000)" : "printf '%010000d' 1";
  const result = await loud.run(root, loudCommand).done;
  assert.equal(result.exitCode, 137);
  assert.ok(Buffer.byteLength(result.output) <= 128);
});

test('Windows cancellation terminates an owned descendant process', { timeout: 15_000, skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t);
  const abort = new AbortController();
  let descendant;
  let received = '';
  t.after(() => { if (descendant) { try { process.kill(descendant); } catch {} } });
  const command = "$child = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30' -WindowStyle Hidden -PassThru; Write-Output \"child:$($child.Id)\"; Start-Sleep -Seconds 30";
  const run = new WorkspaceService().run(root, command, {
    signal: abort.signal,
    onData: chunk => {
      received += chunk;
      const match = /child:(\d+)/.exec(received);
      if (match) { descendant = Number(match[1]); abort.abort(); }
    }
  });
  assert.equal((await run.done).exitCode, 130);
  assert.ok(descendant, received);
  let alive = true;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { process.kill(descendant, 0); }
    catch (error) { if (error.code === 'ESRCH') { alive = false; break; } throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(alive, false, 'The command descendant must terminate with its owning shell.');
  descendant = undefined;
});
