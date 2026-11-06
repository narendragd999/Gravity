import path from 'node:path';
import yauzl from 'yauzl';
import { SaxesParser } from 'saxes';
import { DOCUMENT_EXTENSIONS, DOCUMENT_LIMITS as limits, documentError } from './document-limits.mjs';

const namespaces = { word: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  drawing: 'http://schemas.openxmlformats.org/drawingml/2006/main' };
// Strict Open XML uses a separate standardized URI family. Match each URI
// exactly; unrelated namespaces must not become document text or relationships.
const strictNamespaces = new Map([
  ['http://purl.oclc.org/ooxml/wordprocessingml/main', namespaces.word],
  ['http://purl.oclc.org/ooxml/drawingml/main', namespaces.drawing],
  ['http://purl.oclc.org/ooxml/presentationml/main', 'http://schemas.openxmlformats.org/presentationml/2006/main'],
  ['http://purl.oclc.org/ooxml/spreadsheetml/main', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'],
  ['http://purl.oclc.org/ooxml/officeDocument/relationships', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'],
]);
const normalizedNamespace = uri => strictNamespaces.get(uri) || uri;
const numericOrder = (a, b) => a.localeCompare(b, 'en', { numeric: true });
const elements = (node, name, uri) => {
  const found = [];
  const visit = item => { if (item.name === name && (!uri || item.uri === uri)) found.push(item); for (const child of item.children) visit(child); };
  visit(node); return found;
};
const textOf = node => node.text + node.children.map(textOf).join('');
function append(parts, value) {
  if (!value) return;
  const current = parts.reduce((sum, part) => sum + part.length, 0);
  if (current + value.length + parts.length > limits.characters) throw documentError('text_limit');
  parts.push(value);
}
function result(parts, format, units) {
  const content = parts.join('\n').trim();
  if (!content) throw documentError('no_text');
  if (content.length > limits.characters) throw documentError('text_limit');
  return { content, format, units };
}

function xml(bytes) {
  let source;
  try { source = new TextDecoder(bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : 'utf-8', { fatal: true }).decode(bytes); }
  catch { throw documentError('malformed'); }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw documentError('active_content');
  const parser = new SaxesParser({ xmlns: true });
  let root, nodes = 0; const stack = [];
  parser.on('opentag', tag => {
    if (++nodes > limits.xmlNodes || stack.length >= limits.xmlDepth) throw documentError('archive_limit');
    const node = { name: tag.local, uri: normalizedNamespace(tag.uri), attrs: Object.fromEntries(Object.values(tag.attributes).map(attr =>
      [normalizedNamespace(attr.uri) === 'http://schemas.openxmlformats.org/officeDocument/2006/relationships' && attr.local === 'id' ? 'r:id' : attr.uri ? `{${attr.uri}}${attr.local}` : attr.name, attr.value])), children: [], text: '' };
    if (stack.length) stack.at(-1).children.push(node); else root = node;
    stack.push(node);
  });
  parser.on('text', value => { if (stack.length) stack.at(-1).text += value; });
  parser.on('cdata', value => { if (stack.length) stack.at(-1).text += value; });
  parser.on('closetag', () => stack.pop());
  parser.on('error', () => { throw documentError('malformed'); });
  try { parser.write(source).close(); } catch (error) { throw error?.code ? error : documentError('malformed'); }
  if (!root) throw documentError('malformed');
  return root;
}

const selectedPart = (filename, extension) => filename === '[Content_Types].xml'
  || extension === '.docx' && /^word\/(?:document|footnotes|endnotes|header\d+|footer\d+)\.xml$/.test(filename)
  || extension === '.xlsx' && (/^xl\/(?:workbook|sharedStrings)\.xml$/.test(filename) || filename === 'xl/_rels/workbook.xml.rels' || /^xl\/worksheets\/sheet\d+\.xml$/.test(filename))
  || extension === '.pptx' && (filename === 'ppt/presentation.xml' || filename === 'ppt/_rels/presentation.xml.rels' || /^ppt\/slides\/slide\d+\.xml$/.test(filename));

function officeParts(bytes, extension) {
  if (!Buffer.from(bytes.subarray(0, 4)).equals(Buffer.from([80, 75, 3, 4]))) {
    // Password-protected Office files use an OLE container instead of ZIP.
    if (Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([208,207,17,224,161,177,26,225]))) throw documentError('encrypted');
    throw documentError('malformed');
  }
  return new Promise((resolve, reject) => {
    let zip, failed = false, entryCount = 0, declaredBytes = 0; const names = new Set(), parts = new Map();
    const fail = error => { if (failed) return; failed = true; zip?.close(); reject(error?.code && Object.hasOwn({ archive_limit:1, encrypted:1, active_content:1 }, error.code) ? error : documentError('malformed')); };
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true, decodeStrings: true, strictFileNames: true, validateEntrySizes: true }, (error, opened) => {
      if (error) { fail(error); return; } zip = opened;
      zip.on('error', fail);
      zip.on('end', () => { if (!failed) resolve(parts); });
      zip.on('entry', entry => {
        if (failed) return;
        try {
          if (++entryCount > limits.zipEntries || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
            || entry.uncompressedSize > limits.entryBytes || (declaredBytes += entry.uncompressedSize) > limits.zipBytes
            || entry.uncompressedSize > 1024 * 1024 && entry.uncompressedSize > Math.max(1, entry.compressedSize) * 1000) throw documentError('archive_limit');
          if (entry.generalPurposeBitFlag & 1) throw documentError('encrypted');
          if (names.has(entry.fileName) || entry.fileName.includes('\\') || entry.fileName.startsWith('/') || entry.fileName.split('/').includes('..')) throw documentError('malformed');
          names.add(entry.fileName);
          if (/vbaProject\.bin$/i.test(entry.fileName) || /\/activeX\//i.test(entry.fileName)) throw documentError('active_content');
          if (!selectedPart(entry.fileName, extension)) { zip.readEntry(); return; }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) { fail(streamError); return; }
            let length = 0; const chunks = [];
            stream.on('data', chunk => {
              length += chunk.length;
              if (length > entry.uncompressedSize || length > limits.entryBytes) { stream.destroy(); fail(documentError('archive_limit')); return; }
              chunks.push(chunk);
            });
            stream.on('error', fail);
            stream.on('end', () => { if (!failed) { parts.set(entry.fileName, Buffer.concat(chunks, length)); zip.readEntry(); } });
          });
        } catch (entryError) { fail(entryError); }
      });
      zip.readEntry();
    });
  });
}

function verifyOfficeType(parts, extension) {
  const types = parts.get('[Content_Types].xml');
  if (!types) throw documentError('malformed');
  const tree = xml(types), required = { '.docx': ['/word/document.xml', 'wordprocessingml.document.main+xml'],
    '.xlsx': ['/xl/workbook.xml', 'spreadsheetml.sheet.main+xml'], '.pptx': ['/ppt/presentation.xml', 'presentationml.presentation.main+xml'] }[extension];
  if (!elements(tree, 'Override').some(node => node.attrs.PartName === required[0] && node.attrs.ContentType?.endsWith(required[1]))) throw documentError('malformed');
}

function paragraphText(node, namespace) {
  const pieces = [];
  const visit = item => {
    if (item.uri === namespace && item.name === 't') { pieces.push(item.text); return; }
    if (item.uri === namespace && item.name === 'tab') pieces.push('\t');
    if (item.uri === namespace && ['br', 'cr'].includes(item.name)) pieces.push('\n');
    for (const child of item.children) visit(child);
  };
  visit(node); return pieces.join('').trimEnd();
}
function wordDocument(parts) {
  if (!parts.has('word/document.xml')) throw documentError('malformed');
  const output = [];
  const ordered = ['word/document.xml', ...[...parts.keys()].filter(name => /^word\//.test(name) && name !== 'word/document.xml').sort(numericOrder)];
  for (const name of ordered) {
    const tree = xml(parts.get(name)), blocks = [];
    const visit = node => {
      if (node.uri === namespaces.word && node.name === 'tbl') {
        for (const row of node.children.filter(item => item.name === 'tr')) {
          const cells = row.children.filter(item => item.name === 'tc').map(cell => elements(cell, 'p', namespaces.word).map(p => paragraphText(p, namespaces.word)).join(' / '));
          append(blocks, cells.join(' | '));
        }
        return;
      }
      if (node.uri === namespaces.word && node.name === 'p') { append(blocks, paragraphText(node, namespaces.word)); return; }
      for (const child of node.children) visit(child);
    };
    visit(tree);
    if (blocks.some(part => part.trim())) {
      if (name !== 'word/document.xml') append(output, `[${path.posix.basename(name, '.xml')}]`);
      append(output, blocks.join('\n'));
    }
  }
  return result(output, 'docx', 1);
}

function orderedParts(parts, mainPart, relsPart, kind, fallbackPrefix) {
  const root = parts.get(mainPart), relationships = parts.get(relsPart);
  if (!root) throw documentError('malformed');
  if (!relationships) return [...parts.keys()].filter(name => name.startsWith(fallbackPrefix)).sort(numericOrder).map(name => ({ path: name }));
  const relationMap = new Map(elements(xml(relationships), 'Relationship').filter(node => node.attrs.TargetMode !== 'External').map(node => {
    const target = node.attrs.Target;
    const normalized = target && (target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(mainPart), target)));
    return [node.attrs.Id, normalized];
  }));
  return elements(xml(root), kind).map(node => {
    const name = relationMap.get(node.attrs['r:id']);
    if (!name || !name.startsWith(fallbackPrefix) || !parts.has(name)) throw documentError('malformed');
    return { path: name, name: node.attrs.name };
  });
}

function workbook(parts) {
  const sheets = orderedParts(parts, 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'sheet', 'xl/worksheets/');
  if (!sheets.length) throw documentError('no_text');
  if (sheets.length > limits.sheets) throw documentError('workbook_limit');
  let shared = [], sharedCharacters = 0;
  if (parts.has('xl/sharedStrings.xml')) shared = elements(xml(parts.get('xl/sharedStrings.xml')), 'si').map(node => {
    const value = elements(node, 't').map(textOf).join(''); sharedCharacters += value.length;
    if (sharedCharacters > 2 * 1024 * 1024) throw documentError('workbook_limit'); return value;
  });
  const output = []; let rows = 0, cells = 0, found = false;
  for (let index = 0; index < sheets.length; index++) {
    const sheet = sheets[index], tree = xml(parts.get(sheet.path));
    append(output, `Sheet: ${sheet.name || index + 1}`);
    for (const row of elements(tree, 'row')) {
      if (++rows > limits.rows) throw documentError('workbook_limit');
      const values = [];
      for (const cell of row.children.filter(item => item.name === 'c')) {
        if (++cells > limits.cells) throw documentError('workbook_limit');
        const valueNode = cell.children.find(item => item.name === 'v'), formula = cell.children.find(item => item.name === 'f');
        let value = valueNode ? textOf(valueNode) : '';
        if (cell.attrs.t === 's') { const offset = /^\d+$/.test(value) ? Number(value) : -1; if (!Number.isSafeInteger(offset) || offset < 0 || offset >= shared.length) throw documentError('malformed'); value = shared[offset]; }
        else if (cell.attrs.t === 'inlineStr') value = elements(cell, 't').map(textOf).join('');
        else if (cell.attrs.t === 'b') value = value === '1' ? 'TRUE' : 'FALSE';
        if (formula) value = `formula: ${textOf(formula)}${value ? `; stored result: ${value}` : '; no stored result'}`;
        if (value) { found = true; values.push(`${cell.attrs.r || '?'}: ${value}`); }
      }
      append(output, values.join('\t'));
    }
  }
  if (!found) throw documentError('no_text');
  return result(output, 'xlsx', sheets.length);
}

function presentation(parts) {
  const slides = orderedParts(parts, 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', 'sldId', 'ppt/slides/');
  if (!slides.length) throw documentError('no_text');
  if (slides.length > limits.slides) throw documentError('slide_limit');
  const output = []; let found = false;
  for (let index = 0; index < slides.length; index++) {
    const tree = xml(parts.get(slides[index].path)), paragraphs = elements(tree, 'p', namespaces.drawing).map(node => paragraphText(node, namespaces.drawing)).filter(value => value.trim());
    if (paragraphs.length) found = true;
    append(output, `Slide ${index + 1}`); for (const paragraph of paragraphs) append(output, paragraph);
  }
  if (!found) throw documentError('no_text');
  return result(output, 'pptx', slides.length);
}

async function pdf(bytes, pdfWorkerPath) {
  if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-')) throw documentError('malformed');
  const { default: DOMMatrix } = await import('@thednp/dommatrix');
  globalThis.DOMMatrix = DOMMatrix;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerPath;
  let loading, document;
  try {
    loading = pdfjs.getDocument({ data: Uint8Array.from(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true,
      useWasm: false, enableXfa: false, stopAtErrors: true, disableAutoFetch: true, verbosity: 0 });
    document = await loading.promise;
    if (document.numPages > limits.pages) throw documentError('page_limit');
    const output = []; let found = false;
    for (let pageIndex = 1; pageIndex <= document.numPages; pageIndex++) {
      const page = await document.getPage(pageIndex), text = await page.getTextContent({ disableNormalization: false });
      let line = '', pageCharacters = 0; const lines = [];
      for (const item of text.items) {
        if (typeof item.str !== 'string') continue;
        pageCharacters += item.str.length + 1;
        if (pageCharacters > limits.characters) throw documentError('text_limit');
        line += (line && item.str ? ' ' : '') + item.str;
        if (line.length > limits.characters) throw documentError('text_limit');
        if (item.hasEOL) { lines.push(line); line = ''; }
      }
      if (line) lines.push(line);
      const value = lines.join('\n').trim();
      if (value) { found = true; append(output, `Page ${pageIndex}`); append(output, value); }
      page.cleanup();
    }
    if (!found) throw documentError('no_text');
    return result(output, 'pdf', document.numPages);
  } catch (error) {
    if (error?.name === 'PasswordException') throw documentError('encrypted');
    throw error?.code ? error : documentError('malformed');
  } finally { await loading?.destroy().catch(() => {}); }
}

export async function extractDocument(bytes, extension, { pdfWorkerPath } = {}) {
  if (!(bytes instanceof Uint8Array) || !DOCUMENT_EXTENSIONS.includes(extension)) throw documentError('unsupported');
  if (!bytes.byteLength || bytes.byteLength > limits.bytes) throw documentError('too_large');
  if (extension === '.pdf') return pdf(bytes, pdfWorkerPath);
  const parts = await officeParts(bytes, extension); verifyOfficeType(parts, extension);
  return extension === '.docx' ? wordDocument(parts) : extension === '.xlsx' ? workbook(parts) : presentation(parts);
}
