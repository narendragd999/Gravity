import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
