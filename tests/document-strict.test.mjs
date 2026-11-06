import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDocument } from '../electron/document-extract.mjs';
import { docxFixture, xlsxFixture, pptxFixture } from './document-fixtures.mjs';

const wordNamespace = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
const relationshipsNamespace = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
const strictWord = namespace => `<w:document xmlns:w="${namespace}"><w:body><w:p><w:r><w:t>Strict Word 世界</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell 1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell 2</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
const slide = text => `<p:sld xmlns:p="http://purl.oclc.org/ooxml/presentationml/main" xmlns:a="http://purl.oclc.org/ooxml/drawingml/main"><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`;

test('Strict Open XML Word paragraphs and table cells retain selectable text', async () => {
  const document = await extractDocument(docxFixture(undefined, { 'word/document.xml': strictWord(wordNamespace) }), '.docx');
  assert.equal(document.format, 'docx');
  assert.match(document.content, /Strict Word 世界/); assert.match(document.content, /Cell 1 \| Cell 2/);
});

test('Strict Open XML spreadsheet relationship IDs select internal sheets and preserve stored values', async () => {
  const document = await extractDocument(xlsxFixture({
    'xl/workbook.xml': `<workbook xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main" xmlns:r="${relationshipsNamespace}"><sheets><sheet name="Strict sheet" sheetId="1" r:id="strictId"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="strictId" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Strict value</t></is></c><c r="B1"><v>27</v></c></row></sheetData></worksheet>',
  }), '.xlsx');
  assert.equal(document.units, 1); assert.match(document.content, /Sheet: Strict sheet/);
  assert.match(document.content, /A1: Strict value/); assert.match(document.content, /B1: 27/);
});

test('Strict Open XML slide text follows its internal presentation relationship order', async () => {
  const document = await extractDocument(pptxFixture({
    'ppt/presentation.xml': `<p:presentation xmlns:p="http://purl.oclc.org/ooxml/presentationml/main" xmlns:r="${relationshipsNamespace}"><p:sldIdLst><p:sldId id="256" r:id="strict2"/><p:sldId id="257" r:id="strict1"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="strict1" Target="slides/slide1.xml"/><Relationship Id="strict2" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': slide('Second strict slide'), 'ppt/slides/slide2.xml': slide('First strict slide'),
  }), '.pptx');
  assert.equal(document.units, 2);
  assert.ok(document.content.indexOf('First strict slide') < document.content.indexOf('Second strict slide'));
});

test('namespace lookalikes are not normalized and Strict relationships cannot select remote content', async () => {
  await assert.rejects(extractDocument(docxFixture(undefined, { 'word/document.xml': strictWord(`${wordNamespace}.evil.example`) }), '.docx'), error => error.code === 'no_text');
  await assert.rejects(extractDocument(xlsxFixture({
    'xl/workbook.xml': `<workbook xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main" xmlns:r="${relationshipsNamespace}.evil.example"><sheets><sheet name="Invalid namespace" r:id="rId1"/></sheets></workbook>`,
  }), '.xlsx'), error => error.code === 'malformed');
  await assert.rejects(extractDocument(xlsxFixture({
    'xl/workbook.xml': `<workbook xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main" xmlns:r="${relationshipsNamespace}"><sheets><sheet name="Remote" r:id="remote"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="remote" Target="https://remote.example/private.xlsx" TargetMode="External"/></Relationships>',
  }), '.xlsx'), error => error.code === 'malformed');
});
