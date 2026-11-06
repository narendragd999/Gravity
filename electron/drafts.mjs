import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DRAFT_LIMITS = Object.freeze({ drafts: 128, promptCharacters: 60000, contextCharacters: 60000,
  images: 8, imageCharacters: 24 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, encryptedBytes: 96 * 1024 * 1024 });
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, maximum) => typeof value === 'string' && value.length <= maximum;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(value);
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const fail = message => Object.assign(new Error(message), { code: 'DRAFT_INVALID' });

export function validateDraftKey(key) {
  if (typeof key !== 'string' || !/^(?:conversation:[A-Za-z0-9-]{1,80}|new:(?:personal|[A-Za-z0-9-]{1,80}))$/.test(key)) throw fail('This draft does not belong to a valid chat or project.');
  return key;
}

function fileMetadata(file) {
  if (!object(file) || !text(file.name, 300) || !file.name.trim() || /[\\/\0]/.test(file.name)
    || !integer(file.bytes, 1024 * 1024 * 1024) || !integer(file.characters, 60000) || !integer(file.lines, 10000000)) throw fail('An attached-file draft has invalid metadata.');
  const result = { name: file.name, bytes: file.bytes, characters: file.characters, lines: file.lines };
  if (file.format !== undefined) {
    if (!['pdf', 'docx', 'xlsx', 'pptx', 'binary'].includes(file.format)) throw fail('An attached-file draft has an unsupported format.');
    result.format = file.format;
  }
  for (const [name, maximum] of [['pages', 50], ['sheets', 20], ['slides', 50]]) {
    if (file[name] !== undefined) { if (!integer(file[name], maximum) || file[name] < 1) throw fail('An attached-file draft has invalid document counts.'); result[name] = file[name]; }
  }
  if (file.ocr === true) {
    if (file.format !== 'pdf' || !text(file.ocrLanguage, 40) || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(file.ocrLanguage)) throw fail('An OCR draft has invalid metadata.');
    result.ocr = true; result.ocrLanguage = file.ocrLanguage;
  }
  if (file.previewKind === 'binary') result.previewKind = 'binary';
  return result;
}

function contextSnapshot(context) {
  const relative = context?.path;
  if (!object(context) || !identifier(context.projectId) || !text(relative, 1024) || !relative
    || /[\\\0]/.test(relative) || /^[A-Za-z]:/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')
    || !text(context.label, 1300) || !text(context.content, 40000) || !/^[a-f0-9]{64}$/.test(context.revision || '')
    || !integer(context.startLine, 10000000) || context.startLine < 1 || !integer(context.endLine, 10000000)
    || context.endLine < context.startLine || context.endLine - context.startLine >= 500) throw fail('A selected-project draft has invalid context. Reselect it from the project.');
  return { projectId: context.projectId, path: relative, startLine: context.startLine, endLine: context.endLine,
    revision: context.revision, label: context.label, content: context.content };
}

export function normalizeDraft(value) {
  if (!object(value) || !text(value.prompt ?? '', DRAFT_LIMITS.promptCharacters)) throw fail('Keep a draft message within 60,000 characters.');
  const images = value.images ?? [], contexts = value.contexts ?? [], files = value.files ?? [];
  if (!Array.isArray(images) || images.length > DRAFT_LIMITS.images || images.some(image => !text(image, 12 * 1024 * 1024) || !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image))
    || images.reduce((sum, image) => sum + image.length, 0) > DRAFT_LIMITS.imageCharacters) throw fail('A draft can keep eight images and 24 MB of image data.');
  if (!Array.isArray(contexts) || !Array.isArray(files) || contexts.length + files.length > 4) throw fail('A draft can keep four files or project selections.');
  const safeFiles = files.map(fileMetadata), safeContexts = contexts.map(contextSnapshot);
  if (safeFiles.reduce((sum, file) => sum + file.characters, 0) + safeContexts.reduce((sum, context) => sum + context.content.length, 0) > DRAFT_LIMITS.contextCharacters) throw fail('Draft file context exceeds 60,000 characters.');
  return { prompt: value.prompt || '', images: [...images], contexts: safeContexts, files: safeFiles };
}

const empty = value => !value.prompt && !value.images.length && !value.contexts.length && !value.files.length;

// Snapshots are encrypted locally. Native file paths and attachment IDs never
// enter this store; restored metadata requires a new explicit picker selection.
export class DraftStore {
  constructor(file, { encrypt, decrypt } = {}) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Draft storage needs an absolute application-data path.');
    this.file = file; this.encrypt = encrypt; this.decrypt = decrypt;
    this.selectedKey = 'new:personal'; this.entries = new Map();
    if (!fs.existsSync(file)) return;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > DRAFT_LIMITS.encryptedBytes) throw new Error('Invalid draft file.');
      const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (envelope.version !== 1 || typeof envelope.encrypted !== 'string' || typeof decrypt !== 'function') throw new Error('Invalid encrypted drafts.');
      const plaintext = decrypt(envelope.encrypted);
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > DRAFT_LIMITS.totalBytes) throw new Error('Invalid draft size.');
      const saved = JSON.parse(plaintext);
      validateDraftKey(saved.selectedKey);
      if (!Array.isArray(saved.entries) || saved.entries.length > DRAFT_LIMITS.drafts) throw new Error('Invalid draft inventory.');
      for (const entry of saved.entries) {
        validateDraftKey(entry.key);
        if (this.entries.has(entry.key) || !Number.isFinite(Date.parse(entry.updatedAt))) throw new Error('Invalid draft entry.');
        this.entries.set(entry.key, { value: normalizeDraft(entry.value), updatedAt: entry.updatedAt });
      }
      this.selectedKey = saved.selectedKey;
    } catch {
      throw Object.assign(new Error('Saved drafts could not be read. The original drafts file has been kept unchanged.'), { code: 'DRAFTS_CORRUPT' });
    }
  }
  get(key) { validateDraftKey(key); return this.entries.has(key) ? structuredClone(this.entries.get(key).value) : null; }
  save(key, value) {
    validateDraftKey(key); const normalized = normalizeDraft(value), next = new Map(this.entries);
    if (empty(normalized)) next.delete(key); else next.set(key, { value: normalized, updatedAt: new Date().toISOString() });
    this.publish(next, this.selectedKey); this.entries = next; return structuredClone(normalized);
  }
  clear(key) { validateDraftKey(key); const next = new Map(this.entries); next.delete(key); this.publish(next, this.selectedKey); this.entries = next; return { cleared: true }; }
  select(key) { validateDraftKey(key); if (key !== this.selectedKey) { this.publish(this.entries, key); this.selectedKey = key; } return { key: this.selectedKey }; }
  publish(entries, selectedKey) {
    if (entries.size > DRAFT_LIMITS.drafts) throw Object.assign(new Error('There are 128 saved drafts. Finish or clear an older draft before saving another.'), { code: 'DRAFT_LIMIT' });
    const plaintext = JSON.stringify({ selectedKey, entries: [...entries].map(([key, entry]) => ({ key, ...entry })) });
    if (Buffer.byteLength(plaintext) > DRAFT_LIMITS.totalBytes) throw Object.assign(new Error('Saved drafts exceed the 64 MB local limit. Remove images from an older draft before saving more.'), { code: 'DRAFT_LIMIT' });
    if (typeof this.encrypt !== 'function') throw Object.assign(new Error('Encrypted draft storage is unavailable. Keep the app open until you can save your draft.'), { code: 'DRAFT_STORAGE_UNAVAILABLE' });
    const encrypted = this.encrypt(plaintext);
    if (typeof encrypted !== 'string') throw new Error('Encrypted draft storage returned an invalid result.');
    const data = JSON.stringify({ version: 1, encrypted });
    if (Buffer.byteLength(data) > DRAFT_LIMITS.encryptedBytes) throw new Error('Encrypted drafts exceed the local storage limit.');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) { const stat = fs.lstatSync(this.file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Draft storage must be a regular application-data file.'); }
    const temporary = `${this.file}.${randomUUID()}.tmp`; let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(descriptor, data, 'utf8'); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temporary, this.file);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
