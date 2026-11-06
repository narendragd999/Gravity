import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_BYTES = 32 * 1024 * 1024;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit) => typeof value === 'string' && value.length <= limit;
const fileDetails = file => ({ ...(file.format ? { format: file.format } : {}),
  ...(file.pages ? { pages: file.pages } : {}), ...(file.sheets ? { sheets: file.sheets } : {}), ...(file.slides ? { slides: file.slides } : {}) });
const validFileDetails = file => (file.format === undefined || ['pdf', 'docx', 'xlsx', 'pptx'].includes(file.format))
  && ['pages', 'sheets', 'slides'].every(key => file[key] === undefined || Number.isInteger(file[key]) && file[key] > 0 && file[key] <= (key === 'sheets' ? 20 : 50));
const publicSettings = ['theme', 'uiScale', 'systemPrompt', 'maxSteps'];
const safeUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
};

export function exportData(store) {
  const providers = store.data.providers.filter(p => !p.managedBy && safeUrl(p.baseUrl)).map(p => ({
    id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, models: p.models, defaultModel: p.defaultModel
  }));
  const conversations = store.data.conversations.map(c => ({ title: c.title, mode: c.mode,
    providerId: c.providerId, model: c.model, createdAt: c.createdAt, updatedAt: c.updatedAt,
    messages: c.messages.filter(m => !m.transient).map(m => ({ role: m.role, content: m.content,
      createdAt: m.createdAt, ...(m.images?.length ? { images: m.images } : {}),
      ...(m.files?.length ? { files: m.files.map(file => ({ name: file.name, content: file.content, ...fileDetails(file) })) } : {}),
      ...(m.artifact ? { artifact: { name: m.artifact.name, content: m.artifact.content } } : {}) }))
  }));
  const settings = Object.fromEntries(publicSettings.map(key => [key, store.data.settings[key]]));
  return { format: 'gravity-backup', version: 1, exportedAt: new Date().toISOString(), providers, conversations, settings };
}

export function writeDataExport(store, filename) {
  const raw = JSON.stringify(exportData(store), null, 2);
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('This backup exceeds the 32 MB export limit.');
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, raw, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, filename); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return { fileName: path.basename(filename), conversations: store.data.conversations.length };
}

export function importData(store, raw) {
  if (!text(raw, MAX_BYTES) || Buffer.byteLength(raw) > MAX_BYTES) throw new Error('Choose a Gravity backup under 32 MB.');
  let backup;
  try { backup = JSON.parse(raw); } catch { throw new Error('The backup is not valid JSON.'); }
  if (!plain(backup) || backup.format !== 'gravity-backup' || backup.version !== 1 || !Array.isArray(backup.providers)
    || backup.providers.length > 100 || !Array.isArray(backup.conversations) || backup.conversations.length > 10000 || !plain(backup.settings)) {
    throw new Error('This is not a supported Gravity backup.');
  }
  const next = structuredClone(store.data), providerMap = new Map();
  for (const p of backup.providers) {
    if (!plain(p) || !text(p.id, 200) || !text(p.name, 200) || !['openai', 'gemini', 'anthropic'].includes(p.type)
      || !safeUrl(p.baseUrl) || !Array.isArray(p.models) || p.models.length > 256 || !p.models.every(m => text(m, 200)) || !text(p.defaultModel, 200)) {
      throw new Error('The backup contains an invalid provider.');
    }
    let existing = next.providers.find(item => item.type === p.type && item.baseUrl.replace(/\/$/, '') === p.baseUrl.replace(/\/$/, ''));
    if (!existing) {
      existing = { id: randomUUID(), name: p.name, type: p.type, baseUrl: p.baseUrl, models: [...p.models], defaultModel: p.defaultModel };
      next.providers.push(existing);
    }
    providerMap.set(p.id, existing.id);
  }
  for (const c of backup.conversations) {
    if (!plain(c) || !text(c.title, 500) || !text(c.model, 500) || !['chat', 'plan', 'build'].includes(c.mode)
      || !Array.isArray(c.messages) || c.messages.length > 10000) throw new Error('The backup contains an invalid conversation.');
    const messages = c.messages.map(m => {
      if (!plain(m) || !['user', 'assistant', 'tool'].includes(m.role) || !text(m.content, 200000)) throw new Error('The backup contains an invalid message.');
      if (m.images !== undefined && (!Array.isArray(m.images) || m.images.length > 8 || !m.images.every(i => text(i, 12 * 1024 * 1024) && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(i)))) throw new Error('The backup contains an invalid image.');
      if (m.files !== undefined && (!Array.isArray(m.files) || m.files.length > 4 || !m.files.every(file => plain(file) && text(file.name, 255) && text(file.content, 60000) && validFileDetails(file)) || m.files.reduce((sum, file) => sum + file.content.length, 0) > 60000)) throw new Error('The backup contains invalid file attachments.');
      if (m.artifact !== undefined && (!plain(m.artifact) || !text(m.artifact.name, 200) || !text(m.artifact.content, 200000))) throw new Error('The backup contains an invalid artifact.');
      return { id: randomUUID(), role: m.role, content: m.content, createdAt: new Date().toISOString(),
        ...(m.images ? { images: m.images } : {}), ...(m.files ? { files: m.files.map(file => ({ name: file.name, content: file.content, ...fileDetails(file) })) } : {}), ...(m.artifact ? { artifact: { name: m.artifact.name, content: m.artifact.content } } : {}) };
    });
    const providerId = providerMap.get(c.providerId) || next.providers.find(p => p.id === c.providerId)?.id || next.providers[0]?.id || '';
    next.conversations.push({ id: randomUUID(), title: c.title, model: c.model, providerId, projectId: null, mode: c.mode,
      permissionMode: 'ask', status: 'idle', messages, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  const settings = backup.settings;
  if (settings.theme !== undefined && !['light', 'dark'].includes(settings.theme)) throw new Error('The backup has an invalid theme.');
  if (settings.uiScale !== undefined && ![100, 110, 125].includes(settings.uiScale)) throw new Error('The backup has an invalid text size.');
  if (settings.maxSteps !== undefined && (!Number.isInteger(settings.maxSteps) || settings.maxSteps < 1 || settings.maxSteps > 64)) throw new Error('The backup has an invalid step limit.');
  if (settings.systemPrompt !== undefined && !text(settings.systemPrompt, 20000)) throw new Error('The backup has an invalid instruction length.');
  for (const key of publicSettings) if (settings[key] !== undefined) next.settings[key] = settings[key];
  const previous = store.data;
  store.data = next;
  try { store.save(); } catch (error) { store.data = previous; throw error; }
  return { conversations: backup.conversations.length, providers: next.providers.length - previous.providers.length };
}
