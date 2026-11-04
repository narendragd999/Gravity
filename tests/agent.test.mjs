import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../electron/store.mjs';
import { WorkspaceService } from '../electron/workspace.mjs';
import { AgentRunner } from '../electron/agent.mjs';
import { parseSiteResult } from '../browser-extension/core.mjs';

const response = (content, calls = []) => ({ choices: [{ message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) } }] });
const call = (name, args, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

async function fixture(t, completeFn, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-agent-test-'));
  const project = path.join(directory, 'project'); await fs.mkdir(project);
  const store = new Store(path.join(directory, 'state.json'));
  store.data.projects.push({ id: 'project', path: project, name: 'Test project', createdAt: new Date().toISOString() });
  const workspace = new WorkspaceService();
  const events = [];
  const runner = new AgentRunner({ store, workspace, emit: event => events.push(event), completeFn });
  t.after(async () => { await runner.shutdown(); await fs.rm(directory, { recursive: true, force: true }); });
  const conversation = store.createConversation({ projectId: 'project', ...options });
  const start = content => { runner.start(conversation.id, content); return runner.runs.get(conversation.id).promise; };
  return { store, workspace, runner, events, project, conversation, start };
}
async function approval(runner) {
  for (let i = 0; i < 200; i++) { const id = runner.approvals.keys().next().value; if (id) return id; await delay(5); }
  throw new Error('Expected pending approval.');
}

test('agent reads an existing file, waits for review, then writes with original-content protection', async t => {
  const requests = [];
  const replies = [response(null, [call('read_file', { path: 'note.txt' })]), response(null, [call('propose_file', { path: 'note.txt', content: 'new contents' })]), response('Updated the file.')];
  const f = await fixture(t, async (_, body) => { requests.push(structuredClone(body)); return replies.shift(); });
  await fs.writeFile(path.join(f.project, 'note.txt'), 'old contents');
  const done = f.start('Update note.txt'); const id = await approval(f.runner);
  assert.equal(await fs.readFile(path.join(f.project, 'note.txt'), 'utf8'), 'old contents');
  const review = f.store.conversation(f.conversation.id).messages.find(m => m.approval)?.approval;
  assert.equal(review.original, 'old contents'); assert.equal(review.content, 'new contents');
  f.runner.resolve(id, true); await done;
  assert.equal(await fs.readFile(path.join(f.project, 'note.txt'), 'utf8'), 'new contents');
  assert.equal(review.status, 'approved'); assert.equal(f.store.conversation(f.conversation.id).status, 'idle');
  assert.ok(requests[2].messages.some(m => m.role === 'tool' && /"written":"note.txt"/.test(m.content)));
  assert.equal((await fs.readdir(path.join(f.project, '.antigravity', 'backups'))).length, 1);
});

test('agent refuses replacement without read_file and detects external edits during review', async t => {
  let index = 0;
  const replies = [response(null, [call('propose_file', { path: 'note.txt', content: 'unsafe' })]), response(null, [call('read_file', { path: 'note.txt' })]), response(null, [call('propose_file', { path: 'note.txt', content: 'proposed' })]), response('The file changed during review.')];
  const f = await fixture(t, async (_, body) => {
    if (index === 1) assert.ok(body.messages.some(m => m.role === 'tool' && /Read the current file/.test(m.content)));
    if (index === 3) assert.ok(body.messages.some(m => m.role === 'tool' && /File changed since it was read/.test(m.content)));
    return replies[index++];
  });
  await fs.writeFile(path.join(f.project, 'note.txt'), 'old contents');
  const done = f.start('Update note.txt'); const id = await approval(f.runner);
  await fs.writeFile(path.join(f.project, 'note.txt'), 'external edit'); f.runner.resolve(id, true); await done;
  assert.equal(await fs.readFile(path.join(f.project, 'note.txt'), 'utf8'), 'external edit');
});

test('plan mode excludes mutating tools and rejects unsolicited provider mutation calls', async t => {
  let step = 0;
  const f = await fixture(t, async (_, body) => {
    assert.ok(!body.tools.some(t => ['propose_file', 'run_command'].includes(t.function.name)));
    if (!step++) return response(null, [call('propose_file', { path: 'new.txt', content: 'forbidden' })]);
    assert.ok(body.messages.some(m => m.role === 'tool' && /unavailable in the current mode/.test(m.content)));
    return response('Here is the plan.');
  }, { mode: 'plan' });
  await f.start('Plan a change'); assert.equal(f.runner.approvals.size, 0);
  await assert.rejects(fs.stat(path.join(f.project, 'new.txt')), { code: 'ENOENT' });
});

test('agent rejection does not execute a command and is returned to the model', async t => {
  let step = 0, executed = 0;
  const f = await fixture(t, async (_, body) => {
    if (!step++) return response(null, [call('run_command', { command: 'Write-Output test' })]);
    assert.ok(body.messages.some(m => m.role === 'tool' && /"rejected":true/.test(m.content))); return response('I respected the rejection.');
  });
  f.workspace.run = () => { executed++; throw new Error('Must not run.'); };
  const done = f.start('Run a command'); const pendingId = await approval(f.runner);
  assert.throws(() => f.runner.resolve(pendingId, 'false'), /Approval must be/);
  assert.equal(f.runner.approvals.has(pendingId), true);
  f.runner.resolve(pendingId, false); await done;
  assert.equal(executed, 0); assert.equal(f.store.conversation(f.conversation.id).messages.find(m => m.approval).approval.status, 'rejected');
});

test('stopping an agent rejects outstanding approval and leaves proposed file unwritten', async t => {
  const f = await fixture(t, async () => response(null, [call('propose_file', { path: 'new.txt', content: 'pending' })]));
  const done = f.start('Create a file'); await approval(f.runner); f.runner.stop(f.conversation.id); await done;
  assert.equal(f.runner.approvals.size, 0); assert.equal(f.runner.runs.size, 0); assert.equal(f.store.conversation(f.conversation.id).status, 'idle');
  assert.equal(f.store.conversation(f.conversation.id).messages.at(-1).content, 'Stopped.');
  await assert.rejects(fs.stat(path.join(f.project, 'new.txt')), { code: 'ENOENT' });
});

test('concurrent conversations stream independently and cancel only their own request', async t => {
  const pending = new Map();
  const f = await fixture(t, async (_, body, { signal, onDelta }) => {
    const prompt = body.messages.at(-1).content; onDelta(`partial ${prompt}`);
    return new Promise((resolve, reject) => {
      pending.set(prompt, resolve); signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
  });
  const second = f.store.createConversation({ projectId: 'project' });
  const firstDone = f.start('first'); f.runner.start(second.id, 'second'); const secondDone = f.runner.runs.get(second.id).promise;
  for (let i = 0; i < 100 && pending.size < 2; i++) await delay(5);
  assert.equal(pending.size, 2); assert.throws(() => f.runner.start(second.id, 'duplicate'), /already running/);
  f.runner.stop(f.conversation.id); await firstDone;
  assert.equal(f.store.conversation(second.id).status, 'running');
  pending.get('second')(response('Second completed.')); await secondDone;
  const events = f.events.filter(e => e.type === 'delta'); assert.equal(events.length, 2); assert.notEqual(events[0].conversationId, events[1].conversationId);
  assert.equal(f.store.conversation(second.id).messages.at(-1).content, 'Second completed.');
});

test('agent without a project can create artifacts but receives no filesystem or command tools', async t => {
  let step = 0;
  const f = await fixture(t, async (_, body) => {
    assert.deepEqual(body.tools.map(t => t.function.name), ['create_artifact']);
    if (!step++) return response(null, [call('create_artifact', { name: 'Implementation plan', content: '# Plan\n\nInspect, implement, verify.' })]);
    return response('Plan is attached.');
  }, { projectId: null });
  await f.start('Draft a plan');
  const artifact = f.store.conversation(f.conversation.id).messages.find(m => m.artifact)?.artifact;
  assert.equal(artifact.name, 'Implementation plan'); assert.match(artifact.content, /Inspect, implement, verify/);
});

test('next user turn retains coherent previous tool exchanges and their actual results', async t => {
  let step = 0;
  const f = await fixture(t, async (_, body) => {
    if (step++ === 0) return response(null, [call('read_file', { path: 'note.txt' }, 'previous-read')]);
    if (step === 2) return response('I read note.txt.');
    const toolResult = body.messages.find(m => m.role === 'tool' && m.tool_call_id === 'previous-read');
    assert.ok(toolResult, 'The second turn needs the actual previous tool result.');
    assert.match(toolResult.content, /a unique file value/);
    const toolRequest = body.messages.find(m => m.role === 'assistant' && m.tool_calls?.some(c => c.id === 'previous-read'));
    assert.ok(toolRequest, 'Tool results must have their corresponding assistant call.');
    assert.equal(body.messages.filter(m => m.role === 'user' && m.content === 'What did the file say?').length, 1);
    return response('The file said a unique file value.');
  });
  await fs.writeFile(path.join(f.project, 'note.txt'), 'a unique file value');
  await f.start('Read note.txt'); await f.start('What did the file say?');
  assert.equal(f.store.conversation(f.conversation.id).status, 'idle');
  assert.equal(f.store.conversation(f.conversation.id).messages.at(-1).content, 'The file said a unique file value.');
});


test('browser folder request becomes an approval and creates both folders only after approval', async t => {
  let step = 0;
  const command = process.platform === 'win32' ? "New-Item -ItemType Directory -Path 'One','Two'" : "mkdir 'One' 'Two'";
  const f = await fixture(t, async (_, body) => {
    if (process.platform === 'win32') assert.match(body.messages[0].content, /Windows PowerShell 5.1/);
    if (step++ === 0) return { choices: [{ message: parseSiteResult('```json\n' + JSON.stringify({ content: null, tool_calls: [{ id: 'folders', type: 'function', function: { name: 'run_command', arguments: { command } } }] }) + '\n```', body.tools) }] };
    assert.ok(body.messages.some(m => m.role === 'tool' && m.tool_call_id === 'folders'));
    return response('Created One and Two.');
  });
  const done = f.start('Create folders One and Two.');
  const pending = await approval(f.runner);
  await assert.rejects(fs.stat(path.join(f.project, 'One')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.project, 'Two')), { code: 'ENOENT' });
  f.runner.resolve(pending, true); await done;
  assert.equal((await fs.stat(path.join(f.project, 'One'))).isDirectory(), true);
  assert.equal((await fs.stat(path.join(f.project, 'Two'))).isDirectory(), true);
  assert.equal(f.conversation.status, 'idle');
});
