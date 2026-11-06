import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { DraftStore } from '../electron/drafts.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gravity-drafts-test-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const key = randomBytes(32);
  const crypto = {
    encrypt(text) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64'); },
    decrypt(text) { const data = Buffer.from(text, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'); }
  };
  const file = path.join(directory, 'drafts.json'); return { directory, file, crypto, store: new DraftStore(file, crypto) };
}
const context = { projectId: 'project-one', path: 'src/app.xml', startLine: 2, endLine: 3, revision: 'a'.repeat(64), label: 'src/app.xml:2-3', content: '<message>literal draft context</message>' };
const file = { id: 'private-picker-authority', filename: 'C:\\private\\document.pdf', path: 'C:\\private\\document.pdf', name: 'document.pdf', bytes: 2000, characters: 100, lines: 4, format: 'pdf', pages: 2 };

test('encrypted drafts preserve text, image/context snapshots and last selection across restart without file authority', t => {
  const { store, crypto, file: storage } = fixture(t);
  store.save('conversation:chat-one', { prompt: 'Unsent private draft', images: ['data:image/png;base64,iVBORw0KGgo='], contexts: [context], files: [file], apiKey: 'not-a-draft-field' });
  store.save('new:project-one', { prompt: 'A different project draft' }); store.select('conversation:chat-one');
  const disk = fs.readFileSync(storage, 'utf8'); assert.doesNotMatch(disk, /Unsent private|literal draft|private-picker|C:|not-a-draft-field|iVBORw0/);
  const restarted = new DraftStore(storage, crypto); assert.equal(restarted.selectedKey, 'conversation:chat-one');
  const saved = restarted.get('conversation:chat-one'); assert.equal(saved.prompt, 'Unsent private draft'); assert.deepEqual(saved.contexts, [context]);
  assert.deepEqual(saved.files, [{ name: 'document.pdf', bytes: 2000, characters: 100, lines: 4, format: 'pdf', pages: 2 }]);
  assert.equal(saved.images.length, 1); saved.prompt = 'changed returned clone'; assert.equal(restarted.get('conversation:chat-one').prompt, 'Unsent private draft');
  assert.equal(restarted.get('new:project-one').prompt, 'A different project draft');
});

test('invalid draft boundaries reject before replacing saved content', t => {
  const { store, file: storage } = fixture(t); store.save('new:personal', { prompt: 'Keep this draft' }); const before = fs.readFileSync(storage);
  for (const [key, value] of [
    ['../wrong', { prompt: 'bad' }], ['new:personal', { prompt: 'x'.repeat(60001) }],
    ['new:personal', { contexts: [{ ...context, path: '../outside.xml' }] }], ['new:personal', { contexts: [{ ...context, path: 'C:/private/outside.xml' }] }],
    ['new:personal', { contexts: [{ ...context, revision: 'unknown-revision' }] }], ['new:personal', { images: ['https://private.example/image.png'] }],
    ['new:personal', { images: Array(9).fill('data:image/png;base64,iVBORw0KGgo=') }], ['new:personal', { files: [{ ...file, name: '../outside.pdf' }] }],
    ['new:personal', { files: Array(5).fill(file) }], ['new:personal', { contexts: [context], files: [{ ...file, characters: 60000 }] }],
  ]) assert.throws(() => store.save(key, value), { code: 'DRAFT_INVALID' });
  assert.ok(fs.readFileSync(storage).equals(before)); assert.equal(store.get('new:personal').prompt, 'Keep this draft');
});

test('empty and completed drafts clear only their own owner and retain other saved drafts', t => {
  const { store, file: storage, crypto } = fixture(t); store.save('conversation:one', { prompt: 'one' }); store.save('conversation:two', { prompt: 'two' });
  store.save('conversation:one', { prompt: '', images: [], contexts: [], files: [] }); assert.equal(store.get('conversation:one'), null);
  assert.equal(new DraftStore(storage, crypto).get('conversation:two').prompt, 'two'); store.clear('conversation:two'); assert.equal(store.get('conversation:two'), null);
  assert.equal(fs.readdirSync(path.dirname(storage)).some(name => name.endsWith('.tmp')), false);
});

test('corrupt and undecryptable draft files remain untouched', t => {
  const { store, file: storage, crypto } = fixture(t); store.save('new:personal', { prompt: 'recoverable' }); const encrypted = fs.readFileSync(storage);
  assert.throws(() => new DraftStore(storage, { ...crypto, decrypt() { throw new Error('private failure detail'); } }), { code: 'DRAFTS_CORRUPT' }); assert.ok(fs.readFileSync(storage).equals(encrypted));
  fs.writeFileSync(storage, '{broken'); assert.throws(() => new DraftStore(storage, crypto), { code: 'DRAFTS_CORRUPT' }); assert.equal(fs.readFileSync(storage, 'utf8'), '{broken');
});

test('storage and draft-count limits preserve the previous state instead of dropping drafts', t => {
  const { store, file: storage } = fixture(t);
  for (let index = 0; index < 128; index++) store.save(`conversation:chat-${index}`, { prompt: `Draft ${index}` });
  const before = fs.readFileSync(storage); assert.throws(() => store.save('conversation:overflow', { prompt: 'overflow' }), { code: 'DRAFT_LIMIT' }); assert.ok(fs.readFileSync(storage).equals(before));
  store.clear('conversation:chat-0'); store.save('conversation:overflow', { prompt: 'saved after clear' }); assert.equal(store.get('conversation:overflow').prompt, 'saved after clear');
  const unavailable = new DraftStore(path.join(path.dirname(storage), 'unavailable.json')); assert.throws(() => unavailable.save('new:personal', { prompt: 'cannot store in plaintext' }), { code: 'DRAFT_STORAGE_UNAVAILABLE' });
  assert.equal(fs.existsSync(unavailable.file), false); assert.equal(unavailable.get('new:personal'), null);
});
