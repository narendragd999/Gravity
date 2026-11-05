import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const imageTypes = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp', '.gif': 'gif' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev;
const isImage = (bytes, type) => type === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : type === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : type === 'gif' ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString()) : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';

async function readSelectedFile(filename, limit) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('Choose a file using the attachment picker.');
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Choose a regular file. Folders and linked files cannot be attached.');
  const canonical = await fs.realpath(filename);
  if (path.resolve(canonical).toLowerCase() !== path.resolve(filename).toLowerCase()) throw new Error('Redirected files cannot be attached.');
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

// Only native picker selections grant access. The renderer receives opaque IDs,
// and submitted files provide read-only context, never a new tool workspace.
export class AttachmentStore {
  constructor() { this.entries = new Map(); }
  clear() { this.entries.clear(); }
  async select(filenames, { images = false } = {}) {
    if (!Array.isArray(filenames) || filenames.length > 12) throw new Error('Choose up to four text files and eight images.');
    const files = [], selectedImages = [], rejected = [];
    for (const filename of [...new Set(filenames)]) {
      const name = path.basename(filename);
      try {
        const image = imageTypes[path.extname(name).toLowerCase()];
        if (/\.(?:pdf|docx?|xlsx?|pptx?|zip)$/i.test(name)) throw new Error('This document format is not supported yet. Attach UTF-8 text/code or a supported image.');
        if (image && !images) throw new Error('This connection accepts text only. Choose a text or code file, or switch to an image-capable model.');
        const loaded = await readSelectedFile(filename, image ? 8 * 1024 * 1024 : 40 * 1024);
        if (image) {
          if (!isImage(loaded.bytes, image)) throw new Error('The file contents do not match its image format.');
          if (selectedImages.length >= 8) throw new Error('Attach up to eight images.');
          const encoded = `data:image/${image};base64,${loaded.bytes.toString('base64')}`;
          if (encoded.length + selectedImages.reduce((sum, value) => sum + value.length, 0) > 24 * 1024 * 1024) throw new Error('Attach at most 24 MB of images total.');
          selectedImages.push(encoded);
          continue;
        }
        if (loaded.bytes.includes(0)) throw new Error('This file is binary. Attach UTF-8 text/code or a supported image.');
        let content;
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes); }
        catch { throw new Error('This file is not UTF-8 text. Save it as UTF-8, then select it again.'); }
        const lines = content.split(/\r?\n/).length;
        if (lines > 500) throw new Error('Attach up to 500 lines per text file. Use a project selection for a smaller excerpt.');
        if (files.length >= 4) throw new Error('Attach up to four text files.');
        const id = randomUUID();
        this.entries.set(id, { filename: loaded.filename, revision: digest(loaded.bytes), name });
        files.push({ id, name, bytes: loaded.bytes.length, characters: content.length, lines });
      } catch (error) { rejected.push(`${name}: ${error.code === 'ENOENT' ? 'File no longer exists.' : error.code === 'EACCES' || error.code === 'EPERM' ? 'The file could not be read.' : error.message}`); }
    }
    // Bound outstanding selections; old unused picker IDs expire naturally.
    while (this.entries.size > 128) this.entries.delete(this.entries.keys().next().value);
    return { files, images: selectedImages, rejected };
  }
  async resolve(ids = []) {
    if (!Array.isArray(ids) || ids.length > 4 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('Attach up to four selected text files.');
    const files = [];
    for (const id of ids) {
      const selected = this.entries.get(id);
      if (!selected) throw new Error('This file selection expired. Remove it and attach the file again.');
      const { bytes } = await readSelectedFile(selected.filename, 40 * 1024);
      if (digest(bytes) !== selected.revision) throw new Error(`${selected.name} changed after selection. Remove it and attach it again.`);
      files.push({ name: selected.name, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
    }
    return files;
  }
}
