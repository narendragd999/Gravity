import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftPersistence } from '../src/draftPersistence.ts';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(options = {}) {
  const writes = [], notices = [], saved = new Map();
  const persistence = new DraftPersistence({
    async save(key, value) { writes.push(['save', key, value]); await options.beforeSave?.(key, value); saved.set(key, value); },
    async clear(key) { writes.push(['clear', key]); await options.beforeClear?.(key); saved.delete(key); },
    notice: value => notices.push(value),
  });
  return { persistence, writes, saved, notices };
}

test('close retries failed drafts belonging to earlier chats and reports failure without dropping their snapshots', async () => {
  let blocked = true;
  const { persistence, saved, notices } = fixture({ beforeSave(key) { if (key === 'conversation:earlier' && blocked) throw new Error('private path must not appear'); } });
  persistence.update('conversation:earlier', { prompt: 'Keep earlier unsent work' });
  await assert.rejects(persistence.persist('conversation:earlier'));
  persistence.update('conversation:current', { prompt: 'Current draft' });
  await persistence.persist('conversation:current');
  assert.match(persistence.issue, /kept in this session/);
  await assert.rejects(persistence.flush(), /could not be saved/);
  assert.equal(persistence.dirty.get('conversation:earlier').value.prompt, 'Keep earlier unsent work');
  assert.equal(saved.get('conversation:current').prompt, 'Current draft');
  assert.ok(notices.every(notice => !notice.includes('private path')));
  blocked = false; await persistence.flush();
  assert.equal(saved.get('conversation:earlier').prompt, 'Keep earlier unsent work');
  assert.equal(persistence.dirty.size, 0); assert.equal(persistence.issue, '');
});

test('failed destination persistence never clears the source of a new-chat handoff', async () => {
  const { persistence, saved, writes } = fixture({ beforeSave(key) { if (key === 'conversation:new-chat') throw new Error('Disk full'); } });
  persistence.update('new:personal', { prompt: 'Unsent source' }); await persistence.persist('new:personal');
  await assert.rejects(persistence.handoff('new:personal', 'conversation:new-chat', { prompt: 'Unsent source' }));
  assert.equal(saved.get('new:personal').prompt, 'Unsent source');
  assert.ok(!writes.some(([method, key]) => method === 'clear' && key === 'new:personal'));
  assert.equal(persistence.dirty.get('conversation:new-chat').value.prompt, 'Unsent source');
});

test('a handoff cannot clear newer source edits made while its destination is saving', async () => {
  const entered = deferred(), release = deferred();
  const { persistence, saved, writes } = fixture({ async beforeSave(key) { if (key === 'conversation:new-chat') { entered.resolve(); await release.promise; } } });
  persistence.update('new:personal', { prompt: 'Submitted message' }); await persistence.persist('new:personal');
  const transfer = persistence.handoff('new:personal', 'conversation:new-chat', { prompt: 'Submitted message' });
  await entered.promise;
  persistence.update('new:personal', { prompt: 'A different unsent message' });
  release.resolve(); assert.equal(await transfer, false); await persistence.flush();
  assert.equal(saved.get('new:personal').prompt, 'A different unsent message');
  assert.equal(saved.get('conversation:new-chat').prompt, 'Submitted message');
  assert.ok(!writes.some(([method]) => method === 'clear'));
});

test('a slow older save cannot mark newer edits clean and close flushes their latest value', async () => {
  const entered = deferred(), release = deferred(); let first = true;
  const { persistence, saved } = fixture({ async beforeSave() { if (first) { first = false; entered.resolve(); await release.promise; } } });
  persistence.update('conversation:one', { prompt: 'Old snapshot' }); const pending = persistence.persist('conversation:one'); await entered.promise;
  persistence.update('conversation:one', { prompt: 'Newest unsent text' });
  const closing = persistence.flush(); release.resolve(); await pending; await closing;
  assert.equal(saved.get('conversation:one').prompt, 'Newest unsent text'); assert.equal(persistence.dirty.size, 0);
});

test('successful handoff stores the destination before clearing its source and retries failed source cleanup', async () => {
  let clearBlocked = true;
  const { persistence, saved, writes } = fixture({ beforeClear() { if (clearBlocked) throw new Error('Clear failed'); } });
  persistence.update('new:personal', { prompt: 'Move safely' }); await persistence.persist('new:personal');
  await assert.rejects(persistence.handoff('new:personal', 'conversation:new-chat', { prompt: 'Move safely' }));
  assert.equal(saved.get('new:personal').prompt, 'Move safely'); assert.equal(saved.get('conversation:new-chat').prompt, 'Move safely');
  assert.equal(persistence.dirty.get('new:personal').action, 'clear');
  clearBlocked = false; await persistence.flush();
  assert.equal(saved.has('new:personal'), false); assert.equal(saved.get('conversation:new-chat').prompt, 'Move safely');
  assert.deepEqual(writes.slice(1, 3).map(([method, key]) => [method, key]), [['save', 'conversation:new-chat'], ['clear', 'new:personal']]);
});
