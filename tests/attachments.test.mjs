import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AttachmentStore } from '../electron/attachments.mjs';
import { docxFixture, pdfFixture } from './document-fixtures.mjs';

async function fixture(t, options) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gravity-attachment-'));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  const attachments = new AttachmentStore(options);
  t.after(async () => { await attachments.documents.cancelAll(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, attachments, write: async (name, content) => { const file = path.join(root, name); await fs.writeFile(file, content); return file; } };
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

test('native DOCX and PDF selections expose extracted-text metadata and resolve read-only snapshots without paths', async t => {
  const f = await fixture(t), docx = await f.write('document.docx', docxFixture()), pdf = await f.write('document.pdf', pdfFixture({ pages: 2 }));
  const progress = [], selected = await f.attachments.select([docx, pdf], { onProgress: event => progress.push(event) });
  assert.deepEqual(selected.rejected, []); assert.equal(selected.images.length, 0);
  assert.deepEqual(selected.files.map(file => ({ name: file.name, format: file.format, pages: file.pages })), [
    { name: 'document.docx', format: 'docx', pages: undefined }, { name: 'document.pdf', format: 'pdf', pages: 2 },
  ]);
  assert.deepEqual(progress.map(event => event.name), ['document.docx', 'document.pdf']);
  assert.ok(!JSON.stringify(selected).includes(f.root)); assert.ok(!JSON.stringify(selected).includes('Hello DOCX'));
  const resolved = await f.attachments.resolve(selected.files.map(file => file.id));
  assert.match(resolved[0].content, /Hello DOCX 世界 & team/); assert.equal(resolved[0].format, 'docx');
  assert.match(resolved[1].content, /Page 2\nHello PDF fixture/); assert.equal(resolved[1].format, 'pdf'); assert.equal(resolved[1].pages, 2);
  assert.ok(!JSON.stringify(resolved).includes(f.root));
  assert.equal(selected.files[0].characters, resolved[0].content.length); assert.equal(selected.files[1].characters, resolved[1].content.length);
});

test('changed raw Office bytes reject the selected cached snapshot before it can be sent', async t => {
  const f = await fixture(t), before = docxFixture(), file = await f.write('note.docx', before);
  const selected = await f.attachments.select([file]); assert.equal(selected.files.length, 1);
  const changed = docxFixture('<w:p><w:r><w:t>Changed after native selection</w:t></w:r></w:p>');
  await fs.writeFile(file, changed);
  await assert.rejects(f.attachments.resolve([selected.files[0].id]), /note\.docx changed after selection/);
  assert.deepEqual(await fs.readFile(file), changed);
});

test('cancelled extraction removes this attempt IDs and preserves earlier selected attachments', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const documentExtractor = { cancelAll: async () => {}, extract: async (_bytes, options) => {
    entered(options); return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled parser fixture')), { once: true }));
  } };
  const f = await fixture(t, { documentExtractor });
  const previous = await f.attachments.select([await f.write('previous.md', 'Keep the earlier attachment.')]);
  const accepted = await f.write('new.txt', 'This attempt is cancelled.'), waiting = await f.write('waiting.docx', docxFixture());
  const controller = new AbortController();
  const operation = f.attachments.select([accepted, waiting], { signal: controller.signal });
  const rejected = assert.rejects(operation, /File reading cancelled/);
  const options = await started; assert.equal(options.filename, 'waiting.docx'); assert.equal(options.signal, controller.signal);
  assert.equal(f.attachments.entries.size, 2, 'This attempt accepted a text file before document reading began');
  controller.abort(); await rejected;
  assert.equal(f.attachments.entries.size, 1, 'Cancelled attempt leaves no new native IDs');
  assert.deepEqual(await f.attachments.resolve([previous.files[0].id]), [{ name: 'previous.md', content: 'Keep the earlier attachment.' }]);
});

test('document extraction failure reports an individual error while other selected files remain usable', async t => {
  const f = await fixture(t), good = await f.write('good.docx', docxFixture()), broken = await f.write('broken.pdf', 'damaged PDF bytes'), text = await f.write('notes.md', 'Still accepted.');
  const selected = await f.attachments.select([good, broken, text]);
  assert.deepEqual(selected.files.map(file => file.name), ['good.docx', 'notes.md']);
  assert.equal(selected.rejected.length, 1); assert.match(selected.rejected[0], /broken\.pdf:.*damaged|broken\.pdf:.*match its file format/);
  assert.ok(!selected.rejected[0].includes(f.root));
  assert.equal((await f.attachments.resolve(selected.files.map(file => file.id)))[1].content, 'Still accepted.');
});
