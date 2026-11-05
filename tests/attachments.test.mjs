import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AttachmentStore } from '../electron/attachments.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gravity-attachment-'));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, attachments: new AttachmentStore(), write: async (name, content) => { const file = path.join(root, name); await fs.writeFile(file, content); return file; } };
}
test('native selected files use opaque IDs and reread read-only contents without granting folder access', async t => {
  const f = await fixture(t), file = await f.write('note.md', 'Only this selected file.');
  const selected = await f.attachments.select([file]);
  assert.equal(selected.files.length, 1); assert.deepEqual(selected.rejected, []);
  assert.ok(!JSON.stringify(selected).includes(f.root)); assert.ok(!JSON.stringify(selected).includes('Only this selected file.'));
  assert.deepEqual(await f.attachments.resolve([selected.files[0].id]), [{ name: 'note.md', content: 'Only this selected file.' }]);
  await assert.rejects(f.attachments.resolve([file]), /expired/);
  await assert.rejects(f.attachments.resolve([selected.files[0].id, selected.files[0].id]), /four selected/);
  f.attachments.clear(); await assert.rejects(f.attachments.resolve([selected.files[0].id]), /expired/);
});
test('changed files are rejected before sending while original bytes remain untouched', async t => {
  const f = await fixture(t), file = await f.write('note.txt', 'before');
  const selected = await f.attachments.select([file]);
  await fs.writeFile(file, 'after'); await assert.rejects(f.attachments.resolve([selected.files[0].id]), /changed after selection/);
  assert.equal(await fs.readFile(file, 'utf8'), 'after');
});
test('unsupported, binary, large and long files report partial selection errors without silently truncating', async t => {
  const f = await fixture(t);
  const files = await Promise.all([f.write('good.py', 'print(1)'), f.write('binary.dat', Buffer.from([0,1,2])), f.write('large.txt', 'x'.repeat(40961)), f.write('long.txt', 'x\n'.repeat(501)), f.write('doc.pdf', '%PDF fixture')]);
  const selected = await f.attachments.select([...files, f.root]);
  assert.deepEqual(selected.files.map(file => file.name), ['good.py']); assert.equal(selected.rejected.length, 5);
});
test('image selection respects model capabilities and validates supported file contents', async t => {
  const f = await fixture(t), image = await f.write('image.png', Buffer.from([137,80,78,71,13,10,26,10]));
  const textOnly = await f.attachments.select([image]); assert.equal(textOnly.images.length, 0); assert.match(textOnly.rejected[0], /text only/);
  const selected = await f.attachments.select([image], { images: true }); assert.equal(selected.images.length, 1); assert.deepEqual(selected.rejected, []);
  const fake = await f.write('fake.png', 'not an image'); assert.match((await f.attachments.select([fake], { images: true })).rejected[0], /do not match/);
});
