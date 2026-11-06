import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DocumentExtractor, DOCUMENT_EXTENSIONS, DOCUMENT_LIMITS } from './document-service.mjs';

const imageTypes = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp', '.gif': 'gif' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev;
const isImage = (bytes, type) => type === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : type === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : type === 'gif' ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString()) : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';

async function readSelectedFile(filename, limit) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('Choose a file using the attachment picker.');
  const canonical = await fs.realpath(filename);
  // An explicit native selection also authorizes its resolved file. Windows
  // Downloads/OneDrive folders often use junctions or alternate path names.
  // Keep only that canonical file and verify the opened identity before reading.
  const before = await fs.lstat(canonical);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Choose a regular file. Folders cannot be attached.');
  const handle = await fs.open(canonical, 'r');
  try {
    const opened = await handle.stat();
    if (!same(before, opened)) throw new Error('The file changed while being attached. Select it again.');
    if (opened.size > limit) throw new Error(`This file exceeds the ${Math.round(limit / 1024)} KB attachment limit.`);
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) { const result = await handle.read(buffer, length, buffer.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
    if (length > limit || !same(opened, await handle.stat())) throw new Error('The file changed or exceeds the attachment limit. Select it again.');
    return { filename: canonical, bytes: buffer.subarray(0, length) };
  } finally { await handle.close(); }
}

function binaryPreview(bytes, name, reason = '') {
  const shown = Math.min(bytes.length, 1024);
  const lines = [];
  for (let index = 0; index < shown; index += 16) {
    const part = bytes.subarray(index, Math.min(index + 16, shown));
    lines.push(`${index.toString(16).padStart(8, '0')}  ${[...part].map(value => value.toString(16).padStart(2, '0')).join(' ')}`);
  }
  return `Binary file: ${name}\nSize: ${bytes.length} bytes\nSHA-256: ${digest(bytes)}\n${reason ? `Extraction note: ${reason}\n` : ''}Only file metadata and the first ${shown} bytes are available as a hex preview. The full file has not been decoded, executed, or uploaded as a native model file.\n${lines.join('\n')}`;
}

function decodeText(bytes) {
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
  try {
    const content = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content) ? undefined : content;
  } catch { return undefined; }
}

// Only native picker selections grant access. The renderer receives opaque IDs,
// and submitted files provide read-only context, never a new tool workspace.
export class AttachmentStore {
  constructor({ documentExtractor = new DocumentExtractor() } = {}) { this.entries = new Map(); this.documents = documentExtractor; }
  clear() { this.entries.clear(); this.documents.cancelAll(); }
  async select(filenames, { images = false, signal, ocr = false, onProgress = () => {} } = {}) {
    if (!Array.isArray(filenames) || filenames.length > 12) throw new Error('Choose up to four files and eight images.');
    const files = [], selectedImages = [], rejected = [];
    signal?.throwIfAborted();
    for (const filename of [...new Set(filenames)]) {
      const name = path.basename(filename);
      try {
        const image = imageTypes[path.extname(name).toLowerCase()];
        const document = DOCUMENT_EXTENSIONS.includes(path.extname(name).toLowerCase());
        if (ocr && path.extname(name).toLowerCase() !== '.pdf') throw new Error('Scan PDF with OCR accepts PDF files. Use Attach files for other formats.');
        signal?.throwIfAborted();
        const limit = image && images ? 8 * 1024 * 1024 : DOCUMENT_LIMITS.bytes;
        const loaded = await readSelectedFile(filename, limit);
        if (image && images) {
          if (!isImage(loaded.bytes, image)) throw new Error('The file contents do not match its image format.');
          if (selectedImages.length >= 8) throw new Error('Attach up to eight images.');
          const encoded = `data:image/${image};base64,${loaded.bytes.toString('base64')}`;
          if (encoded.length + selectedImages.reduce((sum, value) => sum + value.length, 0) > 24 * 1024 * 1024) throw new Error('Attach at most 24 MB of images total.');
          selectedImages.push(encoded);
          continue;
        }
        let content, details = {};
        if (document) {
          onProgress({ name, index: files.length + 1, total: filenames.length });
          try {
            const extracted = await this.documents.extract(loaded.bytes, { filename: name, signal, ocr });
            content = extracted.content;
            details = { format: extracted.format, ...(extracted.pages ? { pages: extracted.pages } : {}), ...(extracted.sheets ? { sheets: extracted.sheets } : {}), ...(extracted.slides ? { slides: extracted.slides } : {}), ...(extracted.ocr ? { ocr: true, ocrLanguage: extracted.ocrLanguage } : {}) };
          } catch (error) {
            if (ocr || signal?.aborted || !['no_text', 'encrypted', 'active_content', 'malformed', 'parse_failed'].includes(error.code)) throw error;
            content = binaryPreview(loaded.bytes, name, error.message); details = { format: 'binary', previewKind: 'binary' };
          }
        } else {
          content = image ? undefined : decodeText(loaded.bytes);
          if (content === undefined) { content = binaryPreview(loaded.bytes, name, image ? 'This model accepts text only; image pixels cannot be interpreted.' : 'No supported text decoder recognized this file.'); details = { format: 'binary', previewKind: 'binary' }; }
        }
        signal?.throwIfAborted();
        const lines = content.split(/\r?\n/).length;
        if (files.length >= 4) throw new Error('Attach up to four files.');
        if (content.length + files.reduce((sum, file) => sum + file.characters, 0) > 60000) throw new Error('Attach files with at most 60,000 extracted characters total. Split larger documents.');
        const id = randomUUID();
        this.entries.set(id, { filename: loaded.filename, revision: digest(loaded.bytes), name, limit, content, details });
        files.push({ id, name, bytes: loaded.bytes.length, characters: content.length, lines, ...details });
      } catch (error) {
        if (signal?.aborted) { for (const file of files) this.entries.delete(file.id); throw new Error('File reading cancelled. Your draft and previous attachments are kept.'); }
        rejected.push(`${name}: ${error.code === 'ENOENT' ? 'File no longer exists.' : error.code === 'EACCES' || error.code === 'EPERM' ? 'The file could not be read.' : error.message}`);
      }
    }
    // Bound outstanding selections; old unused picker IDs expire naturally.
    while (this.entries.size > 128) this.entries.delete(this.entries.keys().next().value);
    return { files, images: selectedImages, rejected };
  }
  async preview(id) {
    const selected = this.entries.get(id);
    if (!selected) throw new Error('This file selection expired. Select the file again to preview it.');
    const { bytes } = await readSelectedFile(selected.filename, selected.limit);
    if (digest(bytes) !== selected.revision) throw new Error(`${selected.name} changed after selection. Remove it and attach it again.`);
    return { name: selected.name, content: selected.content, bytes: bytes.length, characters: selected.content.length,
      lines: selected.content.split(/\r?\n/).length, ...selected.details };
  }
  async resolve(ids = []) {
    if (!Array.isArray(ids) || ids.length > 4 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('Attach up to four selected text files.');
    const files = [];
    for (const id of ids) {
      const selected = this.entries.get(id);
      if (!selected) throw new Error('This file selection expired. Remove it and attach the file again.');
      const { bytes } = await readSelectedFile(selected.filename, selected.limit || 40 * 1024);
      if (digest(bytes) !== selected.revision) throw new Error(`${selected.name} changed after selection. Remove it and attach it again.`);
      files.push({ name: selected.name, content: selected.content ?? new TextDecoder('utf-8', { fatal: true }).decode(bytes), ...(selected.details || {}) });
    }
    return files;
  }
}
