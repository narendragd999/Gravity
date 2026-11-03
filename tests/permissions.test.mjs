import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../electron/store.mjs';
import { AgentRunner } from '../electron/agent.mjs';
import { WorkspaceService } from '../electron/workspace.mjs';

const response = (content = 'Finished.', calls = []) => ({ choices: [{ message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) } }] });
const toolCall = (name, args, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

async function fixture(t, completeFn = async () => response(), options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-permissions-test-'));
  const project = path.join(directory, 'project'); await fs.mkdir(project);
  const file = path.join(directory, 'state.json');
  const store = new Store(file);
  store.data.projects.push({ id: 'project', path: project, name: 'Test project', createdAt: new Date().toISOString() });
  const workspace = new WorkspaceService();
  const events = [];
  const runner = new AgentRunner({ store, workspace, emit: e => events.push(e), completeFn });
  t.after(async () => { await runner.shutdown(); assert.equal(path.dirname(directory), os.tmpdir()); await fs.rm(directory, { recursive: true, force: true }); });
  const conversation = store.createConversation({ projectId: 'project', ...options });
  const start = (content = 'Perform the fixture task.', id = conversation.id) => { runner.start(id, content); return runner.runs.get(id).promise; };
  return { directory, project, file, store, workspace, runner, events, conversation, start };
}
async function pendingApproval(runner, message = 'Expected approval before execution.') {
  for (let i = 0; i < 300; i++) { const id = runner.approvals.keys().next().value; if (id) return id; await delay(5); }
  throw new Error(message);
}
function fakeCommand(workspace, executed) {
  workspace.run = (root, command, options = {}) => {
    executed.push({ root, command });
    const result = { exitCode: 0, output: 'Fixture command result; no shell was launched.' };
    options.onData?.(result.output); options.onDone?.(result);
    return { id: options.id, stop() {}, done: Promise.resolve(result) };
  };
}

test('permission persistence defaults new and legacy conversations to ask and fails closed on malformed stored values', async t => {
  const f = await fixture(t);
  assert.equal(f.conversation.permissionMode, 'ask');
  const legacy = f.store.conversation(f.conversation.id); delete legacy.permissionMode;
  const malformed = ['unknown-mode', null, true, 7, { mode: 'full' }].map(value => {
    const c = f.store.createConversation(); f.store.conversation(c.id).permissionMode = value; return c.id;
  });
  const automatic = f.store.createConversation({ permissionMode: 'auto-edits' });
  const full = f.store.createConversation({ permissionMode: 'full', confirmFullAccess: true });
  f.store.save();
  const reloaded = new Store(f.file);
  for (const id of [legacy.id, ...malformed]) assert.equal(reloaded.conversation(id).permissionMode, 'ask');
  assert.equal(reloaded.conversation(automatic.id).permissionMode, 'auto-edits');
  assert.equal(reloaded.conversation(full.id).permissionMode, 'full');
});

test('permission updates reject invalid values atomically and require explicit confirmation to enter full access', async t => {
  const f = await fixture(t); const count = f.store.data.conversations.length;
  for (const permissionMode of ['automatic', 'FULL', '', null, 1, true, {}]) {
    assert.throws(() => f.store.createConversation({ permissionMode }));
    assert.throws(() => f.store.updateConversation({ id: f.conversation.id, permissionMode }));
  }
  assert.equal(f.store.data.conversations.length, count);
  for (const confirmFullAccess of [undefined, false, 'true', 1]) {
    assert.throws(() => f.store.createConversation({ permissionMode: 'full', confirmFullAccess }));
    assert.throws(() => f.store.updateConversation({ id: f.conversation.id, title: 'Must not persist', permissionMode: 'full', confirmFullAccess }));
  }
  assert.equal(f.store.conversation(f.conversation.id).title, 'New conversation');
  assert.equal(f.store.conversation(f.conversation.id).permissionMode, 'ask');
  f.store.updateConversation({ id: f.conversation.id, permissionMode: 'full', confirmFullAccess: true });
  assert.equal(f.store.conversation(f.conversation.id).permissionMode, 'full');
  f.store.updateConversation({ id: f.conversation.id, permissionMode: 'full', title: 'Already confirmed' });
  f.store.updateConversation({ id: f.conversation.id, permissionMode: 'auto-edits' });
  assert.equal(f.store.conversation(f.conversation.id).permissionMode, 'auto-edits');
  f.store.updateConversation({ id: f.conversation.id, permissionMode: 'ask' });
  assert.equal(new Store(f.file).conversation(f.conversation.id).permissionMode, 'ask');
});

test('ask mode waits for a reviewed file decision and does not treat model-supplied permission flags as authorization', async t => {
  let step = 0;
  const f = await fixture(t, async () => !step++ ? response(null, [toolCall('propose_file', { path: 'note.txt', content: 'unapproved', permissionMode: 'full', confirmFullAccess: true, autoApproved: true })]) : response());
  const done = f.start(); const id = await pendingApproval(f.runner);
  await assert.rejects(fs.stat(path.join(f.project, 'note.txt')), { code: 'ENOENT' });
  const review = f.store.conversation(f.conversation.id).messages.find(m => m.approval)?.approval;
  assert.notEqual(review.autoApproved, true); assert.equal(review.status, 'pending');
  f.runner.resolve(id, false); await done;
  assert.equal(f.store.conversation(f.conversation.id).permissionMode, 'ask');
  await assert.rejects(fs.stat(path.join(f.project, 'note.txt')), { code: 'ENOENT' });
});

test('approve-file-edits writes within the project automatically but still waits before every shell command', async t => {
  let step = 0; const executed = [];
  const f = await fixture(t, async () => [response(null, [toolCall('propose_file', { path: 'note.txt', content: 'automatic edit' })]), response(null, [toolCall('run_command', { command: 'fixture-command' })]), response()][step++], { permissionMode: 'auto-edits' });
  fakeCommand(f.workspace, executed);
  const done = f.start(); const id = await pendingApproval(f.runner);
  assert.equal(await fs.readFile(path.join(f.project, 'note.txt'), 'utf8'), 'automatic edit');
  assert.equal(executed.length, 0);
  const reviews = f.store.conversation(f.conversation.id).messages.flatMap(m => m.approval ? [m.approval] : []);
  assert.equal(reviews[0].type, 'write'); assert.equal(reviews[0].autoApproved, true); assert.equal(reviews[0].permissionMode, 'auto-edits'); assert.equal(reviews[0].status, 'approved');
  assert.equal(reviews[1].type, 'command'); assert.equal(reviews[1].status, 'pending'); assert.notEqual(reviews[1].autoApproved, true);
  f.runner.resolve(id, false); await done; assert.equal(executed.length, 0);
});

test('confirmed full access automatically executes both tool types and records their permission policy', { timeout: 4000 }, async t => {
  let step = 0; const executed = [];
  const f = await fixture(t, async () => !step++ ? response(null, [toolCall('propose_file', { path: 'new.txt', content: 'full access fixture' }), toolCall('run_command', { command: 'fixture-command' })]) : response(), { permissionMode: 'full', confirmFullAccess: true });
  fakeCommand(f.workspace, executed); await f.start();
  assert.equal(await fs.readFile(path.join(f.project, 'new.txt'), 'utf8'), 'full access fixture'); assert.equal(executed.length, 1); assert.equal(executed[0].root, f.project);
  assert.equal(f.runner.approvals.size, 0);
  const approvals = f.store.conversation(f.conversation.id).messages.flatMap(m => m.approval ? [m.approval] : []);
  assert.deepEqual(approvals.map(a => a.type), ['write', 'command']);
  assert.ok(approvals.every(a => a.autoApproved === true && a.permissionMode === 'full' && a.status === 'approved'));
});

test('plan mode remains read-only even with confirmed full access and unsolicited mutating calls', async t => {
  let step = 0; const executed = [];
  const f = await fixture(t, async (_, body) => {
    assert.ok(!body.tools.some(t => ['propose_file', 'run_command'].includes(t.function.name)));
    if (!step++) return response(null, [toolCall('propose_file', { path: 'no.txt', content: 'no' }), toolCall('run_command', { command: 'fixture-command' })]);
    assert.equal(body.messages.filter(m => m.role === 'tool' && /unavailable in the current mode/.test(m.content)).length, 2); return response('Plan only.');
  }, { mode: 'plan', permissionMode: 'full', confirmFullAccess: true });
  fakeCommand(f.workspace, executed); await f.start();
  assert.equal(executed.length, 0); assert.equal(f.runner.approvals.size, 0);
  await assert.rejects(fs.stat(path.join(f.project, 'no.txt')), { code: 'ENOENT' });
});

test('full access retains read-before-write, workspace containment, and stale-write protection', { timeout: 4000 }, async t => {
  let step = 0; const requests = [];
  const replies = [
    response(null, [toolCall('propose_file', { path: 'note.txt', content: 'must read first' })]),
    response(null, [toolCall('propose_file', { path: '../outside.txt', content: 'escape' })]),
    response(null, [toolCall('read_file', { path: 'note.txt' })]),
    response(null, [toolCall('propose_file', { path: 'note.txt', content: 'stale proposal' })]),
    response()
  ];
  const f = await fixture(t, async (_, body) => { requests.push(structuredClone(body)); return replies[step++]; }, { permissionMode: 'full', confirmFullAccess: true });
  await fs.writeFile(path.join(f.project, 'note.txt'), 'initial');
  const write = f.workspace.write.bind(f.workspace);
  f.workspace.write = async (...args) => { await fs.writeFile(path.join(f.project, 'note.txt'), 'external newer content'); return write(...args); };
  await f.start();
  assert.ok(requests[1].messages.some(m => m.role === 'tool' && /Read the current file/.test(m.content)));
  assert.ok(requests[2].messages.some(m => m.role === 'tool' && /traversal|relative|escapes/.test(m.content)));
  assert.ok(requests[4].messages.some(m => m.role === 'tool' && /changed since it was read/.test(m.content)));
  assert.equal(await fs.readFile(path.join(f.project, 'note.txt'), 'utf8'), 'external newer content');
  await assert.rejects(fs.stat(path.join(f.directory, 'outside.txt')), { code: 'ENOENT' });
});

test('running conversations cannot change permission policy, including while an approval is pending', async t => {
  const f = await fixture(t, async () => response(null, [toolCall('propose_file', { path: 'pending.txt', content: 'pending' })]));
  const done = f.start(); await pendingApproval(f.runner);
  for (const permissionMode of ['auto-edits', 'full']) assert.throws(() => f.store.updateConversation({ id: f.conversation.id, permissionMode, confirmFullAccess: true }), /running|Stop|stop/);
  assert.equal(f.store.conversation(f.conversation.id).permissionMode, 'ask');
  f.runner.stop(f.conversation.id); await done;
  f.store.updateConversation({ id: f.conversation.id, permissionMode: 'auto-edits' });
  assert.equal(f.store.conversation(f.conversation.id).permissionMode, 'auto-edits');
  await assert.rejects(fs.stat(path.join(f.project, 'pending.txt')), { code: 'ENOENT' });
});

test('each active run uses its captured permission mode even if conversation state changes', async t => {
  let step = 0, f;
  f = await fixture(t, async () => {
    if (!step++) { f.store.conversation(f.conversation.id).permissionMode = 'full'; return response(null, [toolCall('propose_file', { path: 'no-escalation.txt', content: 'unapproved' })]); }
    return response();
  });
  const done = f.start(); const id = await pendingApproval(f.runner);
  assert.equal(f.runner.runs.get(f.conversation.id).permissionMode, 'ask');
  f.runner.resolve(id, false); await done;
  await assert.rejects(fs.stat(path.join(f.project, 'no-escalation.txt')), { code: 'ENOENT' });
});

test('concurrent conversations keep independent permission policies', { timeout: 5000 }, async t => {
  const counts = new Map(); const executed = [];
  const f = await fixture(t, async (_, body) => {
    const prompt = body.messages.find(m => m.role === 'user').content;
    const step = counts.get(prompt) || 0; counts.set(prompt, step + 1);
    return !step ? response(null, [toolCall('run_command', { command: prompt })]) : response('Done.');
  });
  const automatic = f.store.createConversation({ projectId: 'project', permissionMode: 'full', confirmFullAccess: true });
  fakeCommand(f.workspace, executed);
  const askDone = f.start('ask-conversation'); const fullDone = f.start('full-conversation', automatic.id);
  const id = await pendingApproval(f.runner); await fullDone;
  assert.deepEqual(executed.map(e => e.command), ['full-conversation']);
  assert.equal(f.store.conversation(f.conversation.id).status, 'running');
  f.runner.resolve(id, false); await askDone;
  assert.deepEqual(executed.map(e => e.command), ['full-conversation']);
});

test('cancellation immediately before automatic approval still prevents the write', { timeout: 4000 }, async t => {
  let f, stopped = false;
  f = await fixture(t, async () => response(null, [toolCall('propose_file', { path: 'cancelled.txt', content: 'must not be written' })]), { permissionMode: 'full', confirmFullAccess: true });
  const emit = f.runner.emit;
  f.runner.emit = event => {
    emit(event);
    const c = f.store.conversation(f.conversation.id);
    if (!stopped && c.messages.some(m => m.approval?.autoApproved)) { stopped = true; f.runner.stop(c.id); }
  };
  await f.start();
  assert.equal(stopped, true);
  await assert.rejects(fs.stat(path.join(f.project, 'cancelled.txt')), { code: 'ENOENT' });
  assert.equal(f.store.conversation(f.conversation.id).status, 'idle');
});
