import { deflateRawSync, deflateSync } from 'node:zlib';

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}

export function fixtureZip(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, input] of Object.entries(entries)) {
    const entry = typeof input === 'object' && !Buffer.isBuffer(input) ? input : { content: input };
    const bytes = Buffer.from(entry.content), encoded = deflateRawSync(bytes), filename = Buffer.from(name), crc = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(entry.flags || 0, 6); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(encoded.length, 18); header.writeUInt32LE(entry.expandedSize ?? bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, encoded);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(entry.flags || 0, 8); directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(encoded.length, 20); directory.writeUInt32LE(entry.expandedSize ?? bytes.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename); offset += header.length + filename.length + encoded.length;
  }
  const centralBytes = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

const type = (part, contentType) => `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${contentType}"/></Types>`;
export const wordXml = body => `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
export function docxFixture(body = '<w:p><w:r><w:t>Hello DOCX 世界 &amp; team</w:t></w:r></w:p>', extra = {}) {
  return fixtureZip({ '[Content_Types].xml': type('word/document.xml', 'wordprocessingml.document.main+xml'), 'word/document.xml': wordXml(body), ...extra });
}
export function xlsxFixture(extra = {}) {
  return fixtureZip({ '[Content_Types].xml': type('xl/workbook.xml', 'spreadsheetml.sheet.main+xml'),
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Revenue" sheetId="1" rel:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="worksheet"/></Relationships>',
    'xl/sharedStrings.xml': '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><t>Total</t></r><r><t> sales</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c><c r="C1"><f>SUM(B1:B2)</f><v>84</v></c><c r="D1" t="inlineStr"><is><t>読める</t></is></c></row></sheetData></worksheet>', ...extra });
}
export function pptxFixture(extra = {}) {
  return fixtureZip({ '[Content_Types].xml': type('ppt/presentation.xml', 'presentationml.presentation.main+xml'),
    'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Second in presentation</a:t></a:r></a:p></p:sld>',
    'ppt/slides/slide2.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>First in presentation</a:t></a:r></a:p></p:sld>', ...extra });
}
export function pdfFixture({ pages = 1, text = 'Hello PDF fixture', encrypted = false } = {}) {
  const escaped = text.replace(/[()\\]/g, value => `\\${value}`), stream = text ? `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET` : '';
  const objects = [ '<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' ];
  for (let index = 0; index < pages; index++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  if (encrypted) objects.push('<< /Filter /Standard /V 1 /R 2 /Length 40 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>');
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  for (let index = 0; index < objects.length; index++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encrypted ? `/Encrypt ${objects.length} 0 R /ID [<00112233445566778899001122334455> <00112233445566778899001122334455>]` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

// Image-only PDF fixture with a small authored bitmap alphabet. It contains no
// text operators or font objects, so a successful read must use local OCR.
export function scannedPdfFixture({ text = 'GRAVITY OCR TEST 12345', pages = 1 } = {}) {
  const glyphs = {
    ' ': ['00000','00000','00000','00000','00000','00000','00000'],
    G: ['01110','10001','10000','10111','10001','10001','01110'],
    R: ['11110','10001','10001','11110','10100','10010','10001'],
    A: ['01110','10001','10001','11111','10001','10001','10001'],
    V: ['10001','10001','10001','10001','10001','01010','00100'],
    I: ['11111','00100','00100','00100','00100','00100','11111'],
    T: ['11111','00100','00100','00100','00100','00100','00100'],
    Y: ['10001','10001','01010','00100','00100','00100','00100'],
    O: ['01110','10001','10001','10001','10001','10001','01110'],
    C: ['01110','10001','10000','10000','10000','10001','01110'],
    E: ['11111','10000','10000','11110','10000','10000','11111'],
    S: ['01111','10000','10000','01110','00001','00001','11110'],
    1: ['00100','01100','00100','00100','00100','00100','01110'],
    2: ['01110','10001','00001','00010','00100','01000','11111'],
    3: ['11110','00001','00001','01110','00001','00001','11110'],
    4: ['00010','00110','01010','10010','11111','00010','00010'],
    5: ['11111','10000','10000','11110','00001','00001','11110'],
  };
  const scale = 8, width = Math.max(120, text.length * 6 * scale + 64), height = 160;
  const pixels = Buffer.alloc(width * height, 255);
  for (let index = 0; index < text.length; index++) {
    const glyph = glyphs[text[index]] || glyphs[' '];
    for (let row = 0; row < 7; row++) for (let column = 0; column < 5; column++) if (glyph[row][column] === '1') {
      for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) pixels[(48 + row * scale + y) * width + 32 + index * 6 * scale + column * scale + x] = 0;
    }
  }
  const encoded = deflateSync(pixels);
  const objects = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from(`<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages} >>`),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${encoded.length} >>\nstream\n`), encoded, Buffer.from('\nendstream')])];
  const pageHeight = 612 * height / width;
  const stream = `q 612 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`;
  for (let index = 0; index < pages; index++) objects.push(
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${pageHeight}] /Resources << /XObject << /Im0 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`),
    Buffer.from(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`));
  const chunks = [Buffer.from('%PDF-1.7\n')], offsets = [0]; let length = chunks[0].length;
  objects.forEach((object, index) => { offsets.push(length); const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]); chunks.push(part); length += part.length; });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
