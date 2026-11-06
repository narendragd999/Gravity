import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { DocumentExtractor, DOCUMENT_LIMITS } from '../electron/document-service.mjs';
import { docxFixture, xlsxFixture, pptxFixture, pdfFixture, wordXml } from './document-fixtures.mjs';

test('document reader extracts selectable PDF and modern Office text with Unicode, tables, stored formulas and presentation order', async t => {
  const reader = new DocumentExtractor(); t.after(() => reader.cancelAll());
  await t.test('DOCX text and tables', async () => {
    const document = await reader.extract(docxFixture('<w:p><w:r><w:t>Hello 世界</w:t><w:tab/><w:t>team</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'), { filename: 'input.docx' });
    assert.equal(document.format, 'docx'); assert.match(document.content, /Hello 世界\tteam/); assert.match(document.content, /Cell A \| Cell B/);
    assert.ok(!JSON.stringify(document).includes('input.docx'));
  });
  await t.test('XLSX preserves values without evaluating formulas', async () => {
    const document = await reader.extract(xlsxFixture(), { filename: 'input.xlsx' });
    assert.equal(document.sheets, 1); assert.match(document.content, /Sheet: Revenue/); assert.match(document.content, /A1: Total sales/); assert.match(document.content, /formula: SUM\(B1:B2\); stored result: 84/); assert.match(document.content, /読める/);
  });
  await t.test('PPTX uses presentation order rather than filenames', async () => {
    const document = await reader.extract(pptxFixture(), { filename: 'input.pptx' });
    assert.equal(document.slides, 2); assert.ok(document.content.indexOf('First in presentation') < document.content.indexOf('Second in presentation'));
  });
  await t.test('PDF extracts selectable text with page headings', async () => {
    const document = await reader.extract(pdfFixture({ pages: 2 }), { filename: 'input.pdf' });
    assert.equal(document.pages, 2); assert.match(document.content, /Page 1\nHello PDF fixture/); assert.match(document.content, /Page 2/);
  });
});

test('document readers reject unsupported, oversized, malformed, protected, scanned and excessive-page documents without blank or partial success', async t => {
  const reader = new DocumentExtractor(); t.after(() => reader.cancelAll());
  const rejects = (bytes, filename, code) => assert.rejects(reader.extract(bytes, { filename }), error => error.code === code);
  await rejects(Buffer.from('text'), 'input.doc', 'unsupported');
  await rejects(Buffer.alloc(DOCUMENT_LIMITS.bytes + 1), 'input.pdf', 'too_large');
  await rejects(Buffer.from('wrong contents'), 'input.pdf', 'malformed');
  await rejects(docxFixture(), 'input.xlsx', 'malformed');
  await rejects(Buffer.from([208,207,17,224,161,177,26,225]), 'input.docx', 'encrypted');
  await rejects(pdfFixture({ encrypted: true }), 'input.pdf', 'encrypted');
  await rejects(pdfFixture({ text: '' }), 'input.pdf', 'no_text');
  await rejects(pdfFixture({ pages: 51 }), 'input.pdf', 'page_limit');
  await rejects(docxFixture(`<w:p><w:r><w:t>${'x'.repeat(60001)}</w:t></w:r></w:p>`), 'input.docx', 'text_limit');
});

test('Office extraction refuses macros, XML entities, path traversal and archive expansion and never follows external relationships', async t => {
  const reader = new DocumentExtractor(); t.after(() => reader.cancelAll());
  const rejects = (bytes, code) => assert.rejects(reader.extract(bytes, { filename: 'input.docx' }), error => error.code === code);
  await rejects(docxFixture(undefined, { 'word/vbaProject.bin': 'macro fixture' }), 'active_content');
  await rejects(docxFixture(undefined, { 'word/document.xml': '<!DOCTYPE w:document [<!ENTITY injected "private">]>' + wordXml('<w:p><w:r><w:t>&injected;</w:t></w:r></w:p>') }), 'active_content');
  await rejects(docxFixture(undefined, { '../outside.xml': 'unsafe entry' }), 'malformed');
  await rejects(docxFixture(undefined, { 'word/document.xml': { content: wordXml(''), expandedSize: 17 * 1024 * 1024 } }), 'archive_limit');
  await rejects(docxFixture(undefined, { 'word/document.xml': { content: wordXml(''), flags: 1 } }), 'encrypted');
  let requests = 0;
  const server = http.createServer((_request, response) => { requests++; response.end('must not be fetched'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const document = await reader.extract(docxFixture(undefined, { 'word/_rels/document.xml.rels': `<Relationships><Relationship Id="remote" Target="http://127.0.0.1:${server.address().port}/private" TargetMode="External"/></Relationships>` }), { filename: 'input.docx' });
  assert.match(document.content, /Hello DOCX/); assert.equal(requests, 0);
});

test('document cancellation and timeout reap owned processes and leave the reader reusable', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gravity-document-worker-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('gravity-document-worker-')); await fs.rm(directory, { recursive: true, force: true }); });
  const slowWorker = path.join(directory, 'slow-worker.mjs'); await fs.writeFile(slowWorker, 'setTimeout(() => {}, 60000);');
  const reader = new DocumentExtractor({ workerPath: slowWorker }); t.after(() => reader.cancelAll());
  const controller = new AbortController(), operation = reader.extract(docxFixture(), { filename: 'input.docx', signal: controller.signal });
  const cancelledChild = [...reader.active.keys()][0];
  const rejected = assert.rejects(operation, error => error.code === 'cancelled'); controller.abort(); await rejected; assert.equal(reader.active.size, 0);
  assert.ok(cancelledChild.exitCode !== null || cancelledChild.signalCode !== null, 'Cancelled parse is reaped before its promise rejects');
  const second = reader.extract(docxFixture(), { filename: 'input.docx' }), cancelled = assert.rejects(second, error => error.code === 'cancelled'); reader.cancelAll(); await cancelled;
  const timed = new DocumentExtractor({ workerPath: slowWorker, timeoutMs: 20 }); t.after(() => timed.cancelAll());
  const timedOperation = timed.extract(docxFixture(), { filename: 'input.docx' }), timedChild = [...timed.active.keys()][0];
  await assert.rejects(timedOperation, error => error.code === 'timeout'); assert.equal(timed.active.size, 0);
  assert.ok(timedChild.exitCode !== null || timedChild.signalCode !== null, 'Timed-out parse is reaped before its promise rejects');
  const ready = new DocumentExtractor(); t.after(() => ready.cancelAll()); assert.match((await ready.extract(docxFixture(), { filename: 'input.docx' })).content, /Hello DOCX/);
});

test('document isolation keeps the parent responsive and sends no user paths or inherited secrets', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gravity-document-isolation-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('gravity-document-isolation-')); await fs.rm(directory, { recursive: true, force: true }); });
  const workerPath = path.join(directory, 'isolation-reader.mjs');
  await fs.writeFile(workerPath, `process.once('message', input => { const until = Date.now() + 200; while (Date.now() < until) {} process.send({ok:true,result:{format:'docx',units:1,content:JSON.stringify({pid:process.pid,keys:Object.keys(input).sort(),secretPresent:'GRAVITY_DOCUMENT_TEST_SECRET' in process.env,homePresent:'HOME' in process.env})}}); });`);
  const previous = process.env.GRAVITY_DOCUMENT_TEST_SECRET; process.env.GRAVITY_DOCUMENT_TEST_SECRET = 'synthetic-private-marker';
  t.after(() => { if (previous === undefined) delete process.env.GRAVITY_DOCUMENT_TEST_SECRET; else process.env.GRAVITY_DOCUMENT_TEST_SECRET = previous; });
  const reader = new DocumentExtractor({ workerPath }); t.after(() => reader.cancelAll());
  let ticks = 0; const timer = setInterval(() => ticks++, 20); t.after(() => clearInterval(timer));
  const document = await reader.extract(docxFixture(), { filename: path.join(directory, 'private', 'input.docx') });
  const observed = JSON.parse(document.content);
  assert.notEqual(observed.pid, process.pid); assert.equal(observed.secretPresent, false); assert.equal(observed.homePresent, false);
  assert.deepEqual(observed.keys, ['bytes', 'extension', 'pdfWorkerPath']); assert.ok(ticks >= 2);
  assert.equal(reader.active.size, 0);
});

test('document structure counts reject oversized slides, sheets, rows, cells and XML nesting', async t => {
  const reader = new DocumentExtractor(); t.after(() => reader.cancelAll());
  const rejects = (bytes, filename, code) => assert.rejects(reader.extract(bytes, { filename }), error => error.code === code);
  const slides = Array.from({ length: 51 }, (_, index) => index + 1);
  await rejects(pptxFixture({
    'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${slides.map(index => `<p:sldId id="${index}" r:id="rId${index}"/>`).join('')}</p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships>${slides.map(index => `<Relationship Id="rId${index}" Target="slides/slide${index}.xml"/>`).join('')}</Relationships>`,
    ...Object.fromEntries(slides.map(index => [`ppt/slides/slide${index}.xml`, '<slide/>'])),
  }), 'input.pptx', 'slide_limit');
  const sheets = Array.from({ length: 21 }, (_, index) => index + 1);
  await rejects(xlsxFixture({
    'xl/workbook.xml': `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map(index => `<sheet name="Sheet ${index}" r:id="rId${index}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships>${sheets.map(index => `<Relationship Id="rId${index}" Target="worksheets/sheet${index}.xml"/>`).join('')}</Relationships>`,
    ...Object.fromEntries(sheets.map(index => [`xl/worksheets/sheet${index}.xml`, '<worksheet/>'])),
  }), 'input.xlsx', 'workbook_limit');
  await rejects(xlsxFixture({ 'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${'<row><c><v>1</v></c></row>'.repeat(2001)}</sheetData></worksheet>` }), 'input.xlsx', 'workbook_limit');
  await rejects(xlsxFixture({ 'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row>${'<c><v>1</v></c>'.repeat(10001)}</row></sheetData></worksheet>` }), 'input.xlsx', 'workbook_limit');
  await rejects(docxFixture(undefined, { 'word/document.xml': wordXml('<w:x>'.repeat(100) + 'text' + '</w:x>'.repeat(100)) }), 'input.docx', 'archive_limit');
});
