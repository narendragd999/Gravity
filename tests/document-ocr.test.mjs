import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WindowsPdfOcr } from '../electron/document-ocr.mjs';
import { DocumentExtractor, DOCUMENT_LIMITS } from '../electron/document-service.mjs';
import { pdfFixture, scannedPdfFixture, docxFixture } from './document-fixtures.mjs';

const helper = (source, options = {}) => {
  const observed = { children: [], inputs: [] };
  const reader = new WindowsPdfOcr({ platform: 'win32', runtimePath: process.execPath, ...options,
    spawnProcess: (_runtime, args, configuration) => {
      assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
      assert.ok(!args.some(value => /executionpolicy|bypass/i.test(value)));
      observed.inputs.push(configuration.env.GRAVITY_OCR_INPUT);
      const script = path.join(configuration.cwd, 'authored-helper.mjs');
      writeFileSync(script, source);
      const child = spawn(process.execPath, [script], configuration);
      observed.children.push(child); return child;
    } });
  return { reader, observed };
};

test('explicit local OCR reads image-only PDF pages using the installed Windows recognizer', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const reader = new DocumentExtractor(); t.after(() => reader.cancelAll());
  const scanned = scannedPdfFixture({ pages: 2 });
  await assert.rejects(reader.extract(scanned, { filename: 'scan.pdf' }), { code: 'no_text' });
  let result;
  try { result = await reader.extract(scanned, { filename: 'scan.pdf', ocr: true }); }
  catch (error) {
    if (['ocr_unavailable', 'ocr_language_missing'].includes(error.code)) { t.skip(error.message); return; }
    throw error;
  }
  assert.equal(result.ocr, true); assert.equal(result.format, 'pdf'); assert.equal(result.pages, 2);
  assert.match(result.ocrLanguage, /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);
  assert.match(result.content, /Page 1\n.*OCR TEST 12345/); assert.match(result.content, /Page 2\n.*OCR TEST 12345/);
  assert.ok(!JSON.stringify(result).includes('scan.pdf'));
  assert.equal(reader.ocr.active.size, 0);
  await assert.rejects(reader.extract(pdfFixture({ pages: 11 }), { filename: 'many.pdf', ocr: true }), { code: 'ocr_page_limit' });
});

test('OCR is explicit, PDF-only and checks its raw input limits before launching', async () => {
  const missing = new WindowsPdfOcr({ platform: 'linux' });
  await assert.rejects(missing.extract(pdfFixture()), { code: 'ocr_unavailable' });
  const { reader, observed } = helper('throw new Error("must not launch");');
  await assert.rejects(reader.extract(Buffer.from('wrong contents')), { code: 'malformed' });
  await assert.rejects(reader.extract(Buffer.alloc(DOCUMENT_LIMITS.bytes + 1)), { code: 'too_large' });
  await assert.rejects(reader.extract(pdfFixture(), { signal: AbortSignal.abort() }), { code: 'cancelled' });
  const documents = new DocumentExtractor({ ocrReader: reader });
  await assert.rejects(documents.extract(docxFixture(), { filename: 'not-a-scan.docx', ocr: true }), { code: 'unsupported' });
  await assert.rejects(documents.extract(pdfFixture(), { filename: 'scan.pdf', ocr: 'true' }), { code: 'unsupported' });
  assert.equal(observed.children.length, 0);
});

test('local OCR sends only selected bytes, fixed code and a minimal environment to its helper', async t => {
  const secretName = 'GRAVITY_OCR_TEST_SECRET', previous = process.env[secretName]; process.env[secretName] = 'synthetic-private-marker';
  t.after(() => { if (previous === undefined) delete process.env[secretName]; else process.env[secretName] = previous; });
  const source = `import fs from 'node:fs'; const bytes=fs.readFileSync(process.env.GRAVITY_OCR_INPUT); console.log(JSON.stringify({ok:true,result:{format:'pdf',units:1,ocr:true,ocrLanguage:'en-US',content:JSON.stringify({pdf:bytes.subarray(0,5).toString(),secret:process.env.GRAVITY_OCR_TEST_SECRET,home:process.env.HOME,pathEntries:process.env.PATH?.split(';').length})}}));`;
  const { reader, observed } = helper(source); t.after(() => reader.cancelAll());
  const result = await reader.extract(pdfFixture());
  assert.deepEqual(JSON.parse(result.content), { pdf: '%PDF-', pathEntries: 1 });
  assert.equal(result.ocrLanguage, 'en-US'); assert.equal(reader.active.size, 0);
  await assert.rejects(fs.stat(path.dirname(observed.inputs[0])), { code: 'ENOENT' });
});

test('cancel and deadline reap the OCR helper, remove its PDF and release the shared reader slot', async t => {
  const slow = `import fs from 'node:fs'; fs.writeFileSync('ready', 'ready'); setTimeout(() => {},60000);`;
  const { reader, observed } = helper(slow); t.after(() => reader.cancelAll());
  const documents = new DocumentExtractor({ ocrReader: reader }); t.after(() => documents.cancelAll());
  const controller = new AbortController(); const operation = documents.extract(pdfFixture(), { filename: 'scan.pdf', ocr: true, signal: controller.signal });
  const rejected = assert.rejects(operation, { code: 'cancelled' });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (observed.inputs.length && await fs.stat(path.join(path.dirname(observed.inputs[0]), 'ready')).then(() => true, () => false)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(observed.children.length, 1); controller.abort(); await rejected;
  assert.ok(observed.children[0].exitCode !== null || observed.children[0].signalCode !== null);
  assert.equal(reader.active.size, 0); await assert.rejects(fs.stat(path.dirname(observed.inputs[0])), { code: 'ENOENT' });
  const timed = helper(slow, { timeoutMs: 60 }); t.after(() => timed.reader.cancelAll());
  await assert.rejects(timed.reader.extract(pdfFixture()), { code: 'timeout' });
  assert.ok(timed.observed.children[0].exitCode !== null || timed.observed.children[0].signalCode !== null);
  assert.equal(timed.reader.active.size, 0); await assert.rejects(fs.stat(path.dirname(timed.observed.inputs[0])), { code: 'ENOENT' });
});

test('OCR and ordinary documents share the two-job budget and Cancel all settles both helpers', async t => {
  const { reader, observed } = helper('setTimeout(() => {},60000);');
  const documents = new DocumentExtractor({ ocrReader: reader }); t.after(() => documents.cancelAll());
  const first = documents.extract(pdfFixture(), { filename: 'one.pdf', ocr: true }); const firstRejected = assert.rejects(first, { code: 'cancelled' });
  const second = documents.extract(pdfFixture(), { filename: 'two.pdf', ocr: true }); const secondRejected = assert.rejects(second, { code: 'cancelled' });
  await assert.rejects(documents.extract(docxFixture(), { filename: 'other.docx' }), { code: 'busy' });
  await documents.cancelAll(); await Promise.all([firstRejected, secondRejected]);
  assert.equal(documents.active.size, 0); assert.equal(reader.active.size, 0);
  for (const input of observed.inputs) await assert.rejects(fs.stat(path.dirname(input)), { code: 'ENOENT' });
});

test('OCR refuses malformed, over-limit or untrusted helper output and preserves fixed error messages', async t => {
  for (const payload of [
    { ok: true, result: { format: 'pdf', units: 11, ocr: true, ocrLanguage: 'en-US', content: 'text' } },
    { ok: true, result: { format: 'pdf', units: 1, ocr: true, ocrLanguage: 'en-US', content: 'x'.repeat(60001) } },
    { ok: true, result: { format: 'pdf', units: 1, ocr: true, ocrLanguage: 'unsafe/private', content: 'text' } },
  ]) {
    const { reader } = helper(`console.log(${JSON.stringify(JSON.stringify(payload))});`); t.after(() => reader.cancelAll());
    await assert.rejects(reader.extract(pdfFixture()), { code: 'ocr_failed' });
  }
  const untrusted = helper('console.log(JSON.stringify({ok:false,code:"private-path-or-document-text"}));'); t.after(() => untrusted.reader.cancelAll());
  await assert.rejects(untrusted.reader.extract(pdfFixture()), error => error.code === 'parse_failed' && !error.message.includes('private-path'));
  const loud = helper('console.log("x".repeat(600000));'); t.after(() => loud.reader.cancelAll());
  await assert.rejects(loud.reader.extract(pdfFixture()), { code: 'text_limit' });
  assert.equal(loud.reader.active.size, 0);
});
