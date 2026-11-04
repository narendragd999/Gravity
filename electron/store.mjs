import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { normalizePermissionMode, validatePermissionTransition, permissionDescription } from './permissions.mjs';
import { ENV_MASK, normalizeBridgeProfile, normalizeBridgeEnv, validateBridgeUrls } from './bridge-profiles.mjs';

const defaults = () => ({
  version: 1, projects: [], conversations: [], bridgeProfiles: [],
  providers: [
    { id: 'google-gemini', name: 'Google Gemini', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'], defaultModel: 'gemini-2.5-flash' },
    { id: 'openai', name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini'], defaultModel: 'gpt-4o-mini' },
    { id: 'gemini-local', name: 'Gemini Web2API', type: 'openai', baseUrl: 'http://127.0.0.1:8081/v1', models: ['gemini-3.6-flash'], defaultModel: 'gemini-3.6-flash' },
    { id: 'ollama', name: 'Ollama', type: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', models: [], defaultModel: '' }
  ],
  settings: { theme: 'light', uiScale: 110, systemPrompt: '', maxSteps: 16, gatewayPort: 4318, gatewayToken: randomBytes(32).toString('hex'), gatewayAutoStart: true, browserAutoStart: true, bridgesAutoStart: true, bridgeAutoStart: true, bridgeExecutable: '', bridgeConfig: '', bridgePort: 8081 }
});

export class Store {
  constructor(file, { encrypt, decrypt } = {}) {
    this.file = file;
    this.encrypt = encrypt ?? (() => { throw new Error('Secure credential storage is unavailable.'); });
    this.decrypt = decrypt ?? (() => { throw new Error('Secure credential storage is unavailable.'); });
    this.data = defaults();
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.providers) || !Array.isArray(saved.conversations) || !Array.isArray(saved.projects)) throw new Error('Unsupported or corrupt application state. Your state file has not been overwritten.');
      if (saved.bridgeProfiles !== undefined && !Array.isArray(saved.bridgeProfiles)) throw new Error('Unsupported or corrupt bridge profiles. Your state file has not been overwritten.');
      this.data = { ...this.data, ...saved, settings: { ...this.data.settings, ...saved.settings } };
      for (const c of this.data.conversations) {
        c.permissionMode = normalizePermissionMode(c.permissionMode);
        if (c.status === 'running') c.status = 'idle';
        for (const m of c.messages) if (m.approval?.status === 'pending') m.approval.status = 'rejected';
      }
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
  publicState() {
    const { encryptedBrowserPairing, ...data } = this.data;
    return structuredClone({ ...data, conversations: this.data.conversations.map(({ apiHistory, ...c }) => c), providers: this.data.providers.map(p => {
      const { encryptedApiKey, encryptedHeaders, ...publicFields } = p;
      return { ...publicFields, hasApiKey: !!encryptedApiKey, headers: encryptedHeaders ? Object.fromEntries(Object.keys(this.decryptJSON(encryptedHeaders)).map(k => [k, '********'])) : {} };
    }), bridgeProfiles: this.data.bridgeProfiles.map(p => {
      const { encryptedEnv, env, ...fields } = p;
      return { ...fields, env: encryptedEnv ? Object.fromEntries(Object.keys(this.decryptJSON(encryptedEnv)).map(key => [key, ENV_MASK])) : {} };
    }) });
  }
  decryptJSON(value) { return JSON.parse(this.decrypt(value)); }
  browserPairing() {
    if (!this.data.encryptedBrowserPairing) return null;
    const pairing = this.decryptJSON(this.data.encryptedBrowserPairing);
    this.validateBrowserPairing(pairing);
    return pairing;
  }
  validateBrowserPairing(pairing) {
    if (!pairing || !/^[a-p]{32}$/.test(pairing.extensionId || '') || typeof pairing.token !== 'string' || !/^[a-f0-9]{64}$/.test(pairing.token)) throw new Error('Saved browser pairing is invalid.');
  }
  saveBrowserPairing(pairing) {
    this.validateBrowserPairing(pairing);
    const previous = this.data.encryptedBrowserPairing;
    this.data.encryptedBrowserPairing = this.encrypt(JSON.stringify(pairing));
    try { this.save(); }
    catch (error) {
      if (previous === undefined) delete this.data.encryptedBrowserPairing;
      else this.data.encryptedBrowserPairing = previous;
      throw error;
    }
  }
  clearBrowserPairing() {
    const previous = this.data.encryptedBrowserPairing;
    delete this.data.encryptedBrowserPairing;
    try { this.save(); }
    catch (error) { if (previous !== undefined) this.data.encryptedBrowserPairing = previous; throw error; }
  }
  provider(id) {
    const p = this.data.providers.find(x => x.id === id);
    if (!p) throw new Error('Choose a valid provider in Settings.');
    const { encryptedApiKey, encryptedHeaders, ...fields } = p;
    return { ...fields, apiKey: encryptedApiKey ? this.decrypt(encryptedApiKey) : '', headers: encryptedHeaders ? this.decryptJSON(encryptedHeaders) : {} };
  }
  saveProvider(input) {
    if (!['openai', 'anthropic', 'gemini'].includes(input.type)) throw new Error('Unsupported provider protocol.');
    const url = new URL(input.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || [...url.searchParams.keys()].some(k => /(?:key|token|secret|password|authorization|signature|credential|^sig$)/i.test(k))) throw new Error('Base URL must use HTTP(S) without embedded credentials, secret query parameters, or a fragment. Use API key or custom headers for authentication.');
    if (!input.name?.trim()) throw new Error('Provider name is required.');
    const models = [...new Set((input.models ?? []).map(x => String(x).trim()).filter(Boolean))];
    const current = this.data.providers.find(x => x.id === input.id);
    const p = { ...current, id: current?.id ?? randomUUID(), name: input.name.trim(), type: input.type, baseUrl: url.toString(), models, defaultModel: input.defaultModel?.trim() || models[0] || '' };
    if (p.defaultModel && !p.models.includes(p.defaultModel)) p.models.push(p.defaultModel);
    if (input.apiKey !== undefined) p.encryptedApiKey = input.apiKey ? this.encrypt(input.apiKey) : undefined;
    if (input.headers !== undefined) {
      const prior = current?.encryptedHeaders ? this.decryptJSON(current.encryptedHeaders) : {};
      const headers = {};
      for (const [key, value] of Object.entries(input.headers)) {
        if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(key) || /[\r\n]/.test(String(value))) throw new Error('Invalid HTTP header.');
        if (['host', 'content-length', 'connection', 'cookie'].includes(key.toLowerCase())) throw new Error(`Header ${key} is not supported.`);
        if (value === '********') { if (prior[key]) headers[key] = prior[key]; }
        else headers[key] = String(value);
      }
      p.encryptedHeaders = Object.keys(headers).length ? this.encrypt(JSON.stringify(headers)) : undefined;
    }
    for (const profile of this.data.bridgeProfiles.filter(profile => profile.providerId === p.id)) validateBridgeUrls(profile, p);
    if (current) this.data.providers[this.data.providers.indexOf(current)] = p;
    else this.data.providers.push(p);
    this.save();
    return this.publicState().providers.find(x => x.id === p.id);
  }
  bridgeProfile(id) {
    const profile = this.data.bridgeProfiles.find(item => item.id === id);
    if (!profile) throw new Error('Bridge profile not found.');
    const { encryptedEnv, env, ...fields } = profile;
    return { ...fields, env: encryptedEnv ? this.decryptJSON(encryptedEnv) : {} };
  }
  saveBridgeProfile(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Bridge profile must be an object.');
    const current = input.id ? this.data.bridgeProfiles.find(item => item.id === input.id) : undefined;
    if (input.id && !current) throw new Error('Bridge profile not found.');
    const provider = this.data.providers.find(item => item.id === input.providerId);
    const fields = normalizeBridgeProfile(input, provider, current);
    const prior = current?.encryptedEnv ? this.decryptJSON(current.encryptedEnv) : {};
    const env = normalizeBridgeEnv(input.env, prior);
    const profile = { ...fields, id: current?.id ?? randomUUID(), ...(Object.keys(env).length ? { encryptedEnv: this.encrypt(JSON.stringify(env)) } : {}) };
    if (current) this.data.bridgeProfiles[this.data.bridgeProfiles.indexOf(current)] = profile;
    else this.data.bridgeProfiles.push(profile);
    this.save();
    return this.publicState().bridgeProfiles.find(item => item.id === profile.id);
  }
  removeBridgeProfile(id) {
    this.bridgeProfile(id);
    this.data.bridgeProfiles = this.data.bridgeProfiles.filter(item => item.id !== id);
    this.save();
    return { id, removed: true };
  }
  updateSettings(input) {
    const next = { ...this.data.settings };
    for (const key of ['theme', 'uiScale', 'systemPrompt', 'maxSteps', 'gatewayPort', 'gatewayToken', 'gatewayAutoStart', 'browserAutoStart', 'bridgesAutoStart', 'bridgeAutoStart', 'bridgeExecutable', 'bridgeConfig', 'bridgePort']) if (input[key] !== undefined) next[key] = input[key];
    if (!['light', 'dark'].includes(next.theme)) throw new Error('Invalid theme.');
    if (![100, 110, 125].includes(next.uiScale)) throw new Error('Text size must be 100, 110, or 125 percent.');
    for (const key of ['gatewayAutoStart', 'browserAutoStart', 'bridgesAutoStart', 'bridgeAutoStart']) if (typeof next[key] !== 'boolean') throw new Error(`${key} must be true or false.`);
    for (const key of ['gatewayPort', 'bridgePort']) if (!Number.isInteger(next[key]) || next[key] < 1024 || next[key] > 65535) throw new Error('Port must be an integer from 1024 to 65535.');
    if (next.gatewayPort === next.bridgePort) throw new Error('Gateway and bridge need different ports.');
    if (!Number.isInteger(next.maxSteps) || next.maxSteps < 1 || next.maxSteps > 64) throw new Error('Agent step limit must be between 1 and 64.');
    if (typeof next.gatewayToken !== 'string' || next.gatewayToken.length < 16) throw new Error('Gateway token must contain at least 16 characters.');
    for (const key of ['systemPrompt', 'bridgeExecutable', 'bridgeConfig']) if (typeof next[key] !== 'string') throw new Error(`Invalid ${key}.`);
    this.data.settings = next;
    this.save();
    return structuredClone(next);
  }
  conversation(id) {
    const c = this.data.conversations.find(x => x.id === id);
    if (!c) throw new Error('Conversation not found.');
    return c;
  }
  project(id) {
    const p = this.data.projects.find(x => x.id === id);
    if (!p) throw new Error('Open a project folder first.');
    return p;
  }
  createConversation(input = {}) {
    if (input.projectId) this.project(input.projectId);
    const provider = input.providerId ? this.provider(input.providerId) : this.data.providers[0];
    const mode = input.mode ?? 'build';
    if (!['plan', 'build'].includes(mode)) throw new Error('Invalid agent mode.');
    const permissionMode = input.permissionMode === undefined ? 'ask' : input.permissionMode;
    validatePermissionTransition('ask', permissionMode, input.confirmFullAccess);
    const now = new Date().toISOString();
    const c = { id: randomUUID(), title: input.title?.trim() || 'New conversation', projectId: input.projectId || null, providerId: provider?.id || '', model: input.model || provider?.defaultModel || '', mode, permissionMode, messages: [], status: 'idle', createdAt: now, updatedAt: now };
    this.data.conversations.unshift(c); this.save(); return structuredClone(c);
  }
  updateConversation(input) {
    const c = this.conversation(input.id);
    if (c.status === 'running' && ['model', 'providerId', 'mode', 'permissionMode'].some(key => input[key] !== undefined)) throw new Error('Stop the conversation before changing its model, mode, or permissions.');
    if (input.providerId !== undefined) this.provider(input.providerId);
    if (input.mode !== undefined && !['plan', 'build'].includes(input.mode)) throw new Error('Invalid mode.');
    for (const key of ['title', 'model', 'providerId']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 500)) throw new Error(`${key} must be text of up to 500 characters.`);
    if (input.archived !== undefined && typeof input.archived !== 'boolean') throw new Error('archived must be a boolean.');
    if (input.permissionMode !== undefined) validatePermissionTransition(normalizePermissionMode(c.permissionMode), input.permissionMode, input.confirmFullAccess);
    const permissionChanged = input.permissionMode !== undefined && input.permissionMode !== normalizePermissionMode(c.permissionMode);
    const providerSelectionChanged = ['providerId', 'model'].some(key => input[key] !== undefined && input[key] !== c[key]);
    for (const key of ['title', 'archived', 'providerId', 'model', 'mode', 'permissionMode']) if (input[key] !== undefined) c[key] = input[key];
    if (c.status === 'error' && providerSelectionChanged) c.status = 'idle';
    c.updatedAt = new Date().toISOString();
    if (permissionChanged) c.messages.push({ id: randomUUID(), role: 'tool', toolName: 'permissions', content: permissionDescription(c.permissionMode), createdAt: c.updatedAt });
    this.save(); return structuredClone(c);
  }
}
