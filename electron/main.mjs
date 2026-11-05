import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, session, clipboard } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './store.mjs';
import { WorkspaceService } from './workspace.mjs';
import { AgentRunner } from './agent.mjs';
import { Gateway } from './gateway.mjs';
import { GeminiBridge } from './bridge.mjs';
import { ManagedBridges } from './managed-bridges.mjs';
import { Web2ApiSetup } from './web2api-setup.mjs';
import { BrowserConnector } from './browser-connector.mjs';
import { discoverModels } from './providers.mjs';
import { testProviderGeneration } from './provider-test.mjs';
import { prepareBrowserExtensionFolders } from './extension-files.mjs';
import { userDataDirectory, importEnvironmentProviders, startConfiguredServices } from './startup.mjs';
import { providerCapabilities, cleanProviderError } from './provider-capabilities.mjs';
import { writeDataExport, importData } from './data-transfer.mjs';
import { prepareWebsiteData } from './website-data.mjs';
import { AttachmentStore } from './attachments.mjs';

app.setName('Gravity');
if (process.platform === 'win32') app.setAppUserModelId('dev.antigravity.studio');
app.setPath('userData', userDataDirectory(app.getPath('appData')));
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '../dist/index.html');
const devUrl = process.env.GRAVITY_DEV_URL || process.env.ANTIGRAVITY_DEV_URL;
if (devUrl && devUrl !== 'http://127.0.0.1:5173') throw new Error('Development URL must be the local Vite server.');
let mainWindow, store, gateway, bridge, bridges, web2apiSetup, browserConnector, runner, quitting = false;

let serviceStartup = Promise.resolve([]);
let websitePreparation = Promise.resolve();
let dataRecovery = { status: 'ready', message: 'Saved data is available.' };
let permanentWebsiteData, legacyWebsiteSources = [], websiteRoots = () => [];

const terminals = new Map();
const workspace = new WorkspaceService();
const attachments = new AttachmentStore();
const emit = payload => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:event', payload); };
const changed = () => emit({ type: 'state' });
const getState = () => ({ ...store.publicState(), dataRecovery: { status: dataRecovery.status, message: dataRecovery.message }, appVersion: app.getVersion(), web2apiSetup: web2apiSetup.status(), gateway: gateway.status(), bridge: bridge.status(), bridges: bridges.status(), browserConnector: browserConnector.status() });
const bridgeIsActive = id => bridges.status().some(s => s.id === id && (s.running || s.starting));
const providerHasActiveBridge = id => store.data.bridgeProfiles.some(p => p.providerId === id && bridgeIsActive(p.id));
const browserProvider = () => store.data.providers.find(p => p.managedBy === 'browser-connector');
const browserHasAgent = () => store.data.conversations.some(c => c.providerId === browserProvider()?.id && c.status === 'running');
const providerConnectionChanged = input => {
  const prior = store.publicState().providers.find(p => p.id === input.id);
  if (!prior) return false;
  const sortedHeaders = headers => Object.entries(headers || {}).sort(([a], [b]) => a.localeCompare(b));
  return input.type !== prior.type || new URL(input.baseUrl).toString() !== prior.baseUrl || input.apiKey !== undefined
    || (input.headers !== undefined && JSON.stringify(sortedHeaders(input.headers)) !== JSON.stringify(sortedHeaders(prior.headers)));
};

const browserSiteUrls = Object.freeze({ claude: 'https://claude.ai/new', chatgpt: 'https://chatgpt.com/', deepseek: 'https://chat.deepseek.com/', qwen: 'https://chat.qwen.ai/', zai: 'https://chat.z.ai/', gemini: 'https://gemini.google.com/app' });
async function openChrome(url) {
  const candidates = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'), path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'), path.join(app.getPath('appData'), '../Local/Google/Chrome/Application/chrome.exe')];
  let executable;
  for (const candidate of candidates) { try { if ((await fs.stat(candidate)).isFile()) { executable = candidate; break; } } catch { /* Try another standard installation path. */ } }
  if (!executable) throw new Error('Google Chrome was not found. Install Chrome to use the browser connector.');
  await new Promise((resolve, reject) => { const child = execFile(executable, [url], { windowsHide: true }, error => { if (error) reject(new Error('Chrome could not open the requested page.')); }); child.once('spawn', resolve); child.once('error', reject); });
}

async function prepareBrowserExtension() {
  const source = path.join(app.getAppPath(), 'browser-extension');
  const prepared = await prepareBrowserExtensionFolders(source, path.join(app.getPath('userData'), 'browser-extension'));
  const destination = prepared.path;
  clipboard.writeText(destination);
  shell.showItemInFolder(path.join(destination, 'manifest.json'));
  try {
    await openChrome('chrome://extensions/');
    return prepared;
  } catch (error) {
    return { ...prepared, warning: `${error.message} Open chrome://extensions/ manually. Reload an existing Gravity extension, or load the folder below for a first installation.` };
  }
}

async function dispatch(method, args = {}) {
  switch (method) {
    case 'state:get': return getState();
    case 'project:add': {
      let location = args.path;
      if (!location) { const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Open project folder' }); if (result.canceled) return null; location = result.filePaths[0]; }
      const canonical = await fs.realpath(location);
      if (!(await fs.stat(canonical)).isDirectory()) throw new Error('Select a directory.');
      let project = store.data.projects.find(p => p.path.toLowerCase() === canonical.toLowerCase());
      if (!project) { project = { id: randomUUID(), name: path.basename(canonical), path: canonical, createdAt: new Date().toISOString() }; store.data.projects.push(project); store.save(); changed(); }
      return structuredClone(project);
    }
    case 'project:remove': {
      if (store.data.conversations.some(c => c.projectId === args.id && c.status === 'running')) throw new Error('Stop this project’s running conversations before removing it.');
      store.data.projects = store.data.projects.filter(p => p.id !== args.id);
      for (const c of store.data.conversations) if (c.projectId === args.id) c.projectId = null;
      store.save(); changed(); return true;
    }
    case 'conversation:create': { const result = store.createConversation(args); changed(); return result; }
    case 'conversation:update': {
      const c = store.updateConversation(args); changed(); return c;
    }
    case 'conversation:send': {
      const conversation = store.conversation(args.id);
      const refs = args.contexts || [];
      if (!Array.isArray(refs) || refs.length > 4) throw new Error('Attach up to four project excerpts.');
      const contexts = await Promise.all(refs.map(async item => {
        if (!item || item.projectId !== conversation.projectId) throw new Error('Attached files must belong to the conversation project.');
        const excerpt = await workspace.context(store.project(item.projectId).path, item.path, { startLine: item.startLine, endLine: item.endLine });
        if (item.revision !== undefined && item.revision !== excerpt.revision) throw new Error('An attached file changed after it was selected. Remove and attach that context again before sending.');
        return { ...excerpt, projectId: item.projectId };
      }));
      const files = await attachments.resolve(args.fileIds);
      return runner.start(args.id, args.content, args.images, contexts, files);
    }
    case 'attachments:choose': {
      const provider = args.providerId ? store.provider(args.providerId) : undefined;
      const capabilities = provider ? providerCapabilities(provider, args.model) : { images: false };
      const result = await dialog.showOpenDialog(mainWindow, { title: 'Attach files', properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Text and code', extensions: ['txt', 'md', 'json', 'csv', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'py', 'html', 'css', 'yaml', 'yml', 'xml', 'log'] },
          ...(capabilities.images ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] : []), { name: 'All files', extensions: ['*'] }] });
      return result.canceled ? { files: [], images: [], rejected: [] } : attachments.select(result.filePaths, capabilities);
    }
    case 'conversation:stop': return runner.stop(args.id);
    case 'approval:resolve': if (typeof args.approved !== 'boolean') throw new Error('Approval must be true or false.'); return runner.resolve(args.id, args.approved);
    case 'provider:save': {
      const connectionChanged = providerConnectionChanged(args);
      if (connectionChanged && args.id === browserProvider()?.id && browserConnector.status().running) throw new Error('Stop the browser connector before changing its generated provider connection.');
      if (connectionChanged && providerHasActiveBridge(args.id)) throw new Error('Stop or disconnect this provider’s bridge before changing its connection.');
      if (connectionChanged && store.data.conversations.some(c => c.providerId === args.id && c.status === 'running')) throw new Error('Stop conversations using this provider before changing its connection.');
      const result = store.saveProvider(args); changed(); return result;
    }
    case 'provider:remove': {
      if (args.id === browserProvider()?.id && browserConnector.status().running) throw new Error('Stop the browser connector before removing its provider.');
      if (store.data.conversations.some(c => c.providerId === args.id && c.status === 'running')) throw new Error('Stop conversations using this provider before removing it.');
      if (store.data.bridgeProfiles.some(p => p.providerId === args.id)) throw new Error('Remove the linked bridge profiles before removing this provider.');
      store.data.providers = store.data.providers.filter(p => p.id !== args.id); store.save(); changed(); return true;
    }
    case 'provider:models': return discoverModels(store.provider(args.id));
    case 'provider:capabilities': return providerCapabilities(store.provider(args.id), args.model);
    case 'provider:test': {
      const started = Date.now();
      let result;
      try { result = await testProviderGeneration(store.provider(args.id), { model: args.model, browserStatus: browserConnector.status() }); }
      catch (error) { result = { ok: false, message: cleanProviderError(error), code: error.code }; }
      const provider = store.data.providers.find(p => p.id === args.id);
      if (provider) provider.lastTest = { ...result, model: args.model, checkedAt: new Date().toISOString(), durationMs: Date.now() - started };
      changed(); return result;
    }
    case 'data:export': {
      const result = await dialog.showSaveDialog(mainWindow, { title: 'Export conversations and nonsecret settings', defaultPath: `Gravity-backup-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'Gravity backup', extensions: ['json'] }] });
      if (result.canceled || !result.filePath) return { cancelled: true };
      return writeDataExport(store, result.filePath);
    }
    case 'data:import': {
      if (store.data.conversations.some(c => c.status === 'running')) throw new Error('Stop running conversations before importing a backup.');
      const result = await dialog.showOpenDialog(mainWindow, { title: 'Import a Gravity backup', properties: ['openFile'], filters: [{ name: 'Gravity backup', extensions: ['json'] }] });
      if (result.canceled) return { cancelled: true };
      const file = result.filePaths[0], info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new Error('Choose a regular Gravity backup under 32 MB.');
      const imported = importData(store, await fs.readFile(file, 'utf8')); changed(); return imported;
    }
    case 'settings:save': {
      if (gateway.status().running && ((args.gatewayPort !== undefined && args.gatewayPort !== store.data.settings.gatewayPort) || (args.gatewayToken !== undefined && args.gatewayToken !== store.data.settings.gatewayToken))) throw new Error('Stop the gateway before changing its port or token.');
      const result = store.updateSettings(args); changed(); return result;
    }
    case 'gateway:start': return gateway.start({ port: store.data.settings.gatewayPort, token: store.data.settings.gatewayToken });
    case 'gateway:stop': return gateway.stop();
    case 'bridge:start': {
      const provider = store.data.providers.find(p => p.id === 'gemini-local') || store.data.providers.find(p => p.name === 'Gemini Web2API');
      if (provider && (providerHasActiveBridge(provider.id) || store.data.conversations.some(c => c.providerId === provider.id && c.status === 'running'))) throw new Error('Stop conversations and disconnect custom bridges using the Gemini provider before starting the built-in Gemini bridge.');
      return bridge.start({ executable: store.data.settings.bridgeExecutable, config: store.data.settings.bridgeConfig, port: store.data.settings.bridgePort });
    }
    case 'bridge:stop': return bridge.stop();
    case 'bridge:choose': {
      const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: args.kind === 'config' ? [{ name: 'JSON configuration', extensions: ['json'] }] : [{ name: 'Executable', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }] });
      return result.canceled ? '' : result.filePaths[0];
    }
    case 'bridges:save': {
      if (args.id && bridgeIsActive(args.id)) throw new Error('Stop or disconnect this bridge before editing its profile.');
      const profile = store.saveBridgeProfile(args); changed(); return profile;
    }
    case 'bridges:remove': {
      if (bridgeIsActive(args.id)) throw new Error('Stop or disconnect this bridge before removing it.');
      const result = store.removeBridgeProfile(args.id); changed(); return result;
    }
    case 'bridges:start': return bridges.start(args.id);
    case 'bridges:stop': {
      const profile = store.bridgeProfile(args.id);
      if (store.data.conversations.some(c => c.providerId === profile.providerId && c.status === 'running')) throw new Error('Stop conversations using this bridge before stopping it.');
      return bridges.stop(args.id);
    }
    case 'bridges:check': return bridges.check(args.id);
    case 'web2api:refresh': await websitePreparation; return web2apiSetup.refresh();
    case 'web2api:connect': {
      if (args.forceLogin !== undefined && typeof args.forceLogin !== 'boolean') throw new Error('Sign-in refresh must be true or false.');
      await websitePreparation;
      return web2apiSetup.connect(args.siteId, { forceLogin: args.forceLogin === true, browserChannel: args.browserChannel });
    }
    case 'web2api:browsers': await websitePreparation; return web2apiSetup.listBrowsers();
    case 'web2api:setBrowser': await websitePreparation; return web2apiSetup.setBrowser(args.channel);
    case 'web2api:diagnostics': return web2apiSetup.diagnostics();
    case 'web2api:openAccount': await websitePreparation; return web2apiSetup.openAccount(args.siteId);
    case 'web2api:migrate': {
      await websitePreparation;
      if (web2apiSetup.status().busy || web2apiSetup.pendingSiteId) throw new Error('Finish or cancel website setup before migrating data.');
      const providerId = web2apiSetup.status().providerId;
      if (store.data.conversations.some(c => c.providerId === providerId && c.status === 'running')) throw new Error('Stop website conversations before migrating their saved data.');
      const stopped = [];
      for (const profile of store.data.bridgeProfiles.filter(p => p.providerId === providerId)) {
        if (bridges.entries.get(profile.id)?.child) { await bridges.stop(profile.id); stopped.push(profile.id); }
      }
      await web2apiSetup.close();
      dataRecovery = await prepareWebsiteData({ destination: permanentWebsiteData, sources: legacyWebsiteSources, recover: true });
      web2apiSetup = new Web2ApiSetup({ store, bridges, companionRoots: websiteRoots(dataRecovery.dataDir), previousDataDirs: legacyWebsiteSources, changed, appVersion: app.getVersion() });
      await web2apiSetup.prepareStartup();
      for (const id of stopped) await bridges.start(id);
      changed(); return { status: dataRecovery.status, message: dataRecovery.message };
    }
    case 'web2api:finishLogin': return web2apiSetup.finishLogin();
    case 'web2api:cancel': return web2apiSetup.cancel();
    case 'bridges:choose': {
      if (!['executable', 'directory'].includes(args.kind)) throw new Error('Choose an executable or working directory.');
      const result = await dialog.showOpenDialog(mainWindow, args.kind === 'directory'
        ? { properties: ['openDirectory'], title: 'Choose the bridge working directory' }
        : { properties: ['openFile'], title: 'Choose a bridge executable or Python/Node runtime', filters: [{ name: 'Executable', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }] });
      return result.canceled ? '' : result.filePaths[0];
    }
    case 'browser:start': return browserConnector.start();
    case 'browser:stop': if (browserHasAgent()) throw new Error('Stop conversations using the browser connector first.'); return browserConnector.stop();
    case 'browser:approve': return browserConnector.approvePairing(args.id);
    case 'browser:revoke': return browserConnector.revoke();
    case 'browser:openSetup': return prepareBrowserExtension();
    case 'browser:openSite': {
      if (!Object.prototype.hasOwnProperty.call(browserSiteUrls, args.siteId)) throw new Error('Choose a supported website.');
      await openChrome(browserSiteUrls[args.siteId]); return { opened: args.siteId };
    }
    case 'workspace:list': return workspace.list(store.project(args.projectId).path, args.path || '');
    case 'workspace:read': return workspace.read(store.project(args.projectId).path, args.path);
    case 'workspace:write': return workspace.write(store.project(args.projectId).path, args.path, args.content, args.original);
    case 'workspace:search': return workspace.search(store.project(args.projectId).path, args.query);
    case 'workspace:git': return workspace.git(store.project(args.projectId).path);
    case 'workspace:context': return { ...await workspace.context(store.project(args.projectId).path, args.path, args), projectId: args.projectId };
    case 'workspace:review': return workspace.review(store.project(args.projectId).path, args.path);
    case 'workspace:undo': {
      if (store.data.conversations.some(c => c.projectId === args.projectId && c.status === 'running')) throw new Error('Stop this project’s running conversations before undoing an edit.');
      return workspace.undo(store.project(args.projectId).path, args.path);
    }
    case 'workspace:guide': return workspace.guide(store.project(args.projectId).path);
    case 'terminal:run': {
      if (terminals.size >= 8) throw new Error('Up to eight commands can run at once.');
      const id = args.id ?? randomUUID();
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || terminals.has(id)) throw new Error('Command ID must be unique.');
      const operation = workspace.run(store.project(args.projectId).path, args.command, { id, onData: text => emit({ type: 'terminal', id, text }), onDone: result => { terminals.delete(id); emit({ type: 'terminal', id, text: '', done: true, exitCode: result.exitCode }); } });
      terminals.set(id, operation); return { id };
    }
    case 'terminal:stop': terminals.get(args.id)?.stop(); return true;
    case 'clipboard:write': if (typeof args.text !== 'string' || args.text.length > 2000000) throw new Error('Invalid clipboard text.'); clipboard.writeText(args.text); return true;
    case 'shell:openExternal': { const url = new URL(args.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only web URLs can be opened.'); await shell.openExternal(url.toString()); return true; }
    case 'shell:reveal': {
      // Only reveal an admitted project directory or the app's settings directory.
      const target = store.data.projects.find(p => p.path === args.path)?.path;
      if (!target) throw new Error('Select a project folder to reveal.'); shell.showItemInFolder(target); return true;
    }
    case 'window:action':
      if (args.action === 'minimize') mainWindow.minimize();
      else if (args.action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
      else if (args.action === 'close') mainWindow.close();
      return true;
    default: throw new Error(`Unsupported desktop operation: ${method}`);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1450, height: 960, minWidth: 980, minHeight: 640, title: 'Gravity', icon: path.join(here, '../build/icon.ico'), backgroundColor: '#f8f9fb', frame: false, show: false,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== (devUrl || pathToFileURL(entry).href)) event.preventDefault(); });
  mainWindow.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) attachments.clear(); });
  mainWindow.on('closed', () => attachments.clear());
  mainWindow.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(mainWindow, { type: 'question', buttons: ['Keep editing', 'Discard changes'], defaultId: 0, cancelId: 0, title: 'Unsaved changes', message: 'Close the app and discard unsaved editor changes?' });
    if (choice === 1) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (devUrl) mainWindow.loadURL(devUrl); else mainWindow.loadFile(entry);
}

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    const encrypt = value => { if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('OS credential encryption is unavailable.'); return safeStorage.encryptString(value).toString('base64'); };
    const decrypt = value => safeStorage.decryptString(Buffer.from(value, 'base64'));
    store = new Store(path.join(app.getPath('userData'), 'state.json'), { encrypt, decrypt });
    importEnvironmentProviders(store);
    store.save();
    gateway = new Gateway({ getProviders: () => store.publicState().providers, getProvider: id => store.provider(id), onChange: changed });
    bridges = new ManagedBridges({ store, onChange: changed });
    const portableDirectory = process.env.PORTABLE_EXECUTABLE_DIR || (process.env.PORTABLE_EXECUTABLE_FILE ? path.dirname(process.env.PORTABLE_EXECUTABLE_FILE) : path.dirname(process.execPath));
    const existingCompanion = path.join(portableDirectory, 'Gravity-Web2API');
    permanentWebsiteData = path.join(app.getPath('userData'), 'web2api');
    legacyWebsiteSources = [path.join(existingCompanion, '.data'), ...store.data.bridgeProfiles.map(p => {
      const index = p.args?.indexOf('--data-dir'); return index >= 0 ? p.args[index + 1] : undefined;
    }).filter(Boolean)];
    let websiteDataDir = permanentWebsiteData;
    if (app.isPackaged) { dataRecovery = await prepareWebsiteData({ destination: permanentWebsiteData, sources: legacyWebsiteSources }); websiteDataDir = dataRecovery.dataDir; }
    websiteRoots = dataDir => !app.isPackaged && process.env.GRAVITY_TEST_WEB2API_ROOT
      ? [process.env.GRAVITY_TEST_WEB2API_ROOT]
      : app.isPackaged ? [{ root: path.join(process.resourcesPath, 'web2api'), dataDir }, existingCompanion]
        : [path.join(app.getAppPath(), 'release', 'Gravity-Web2API')];
    web2apiSetup = new Web2ApiSetup({ store, bridges, companionRoots: websiteRoots(websiteDataDir), previousDataDirs: legacyWebsiteSources, changed, appVersion: app.getVersion() });
    browserConnector = new BrowserConnector({ store, onChange: changed, port: !app.isPackaged && process.env.ANTIGRAVITY_TEST_CONNECTOR_PORT === '0' ? 0 : 4319, onReady: ({ url, token }) => {
      const existing = browserProvider();
      const saved = store.saveProvider({ ...existing, name: existing?.name || 'Browser Connector', type: 'openai', baseUrl: url, apiKey: token, headers: {}, models: ['claude-web', 'chatgpt-web', 'deepseek-web', 'qwen-web', 'zai-web', 'gemini-web'], defaultModel: existing?.defaultModel || 'claude-web' });
      store.data.providers.find(p => p.id === saved.id).managedBy = 'browser-connector'; store.save();
    } });
    bridge = new GeminiBridge({ directory: app.getPath('userData'), onChange: changed, onReady: ({ port, token }) => {
      const p = store.data.providers.find(p => p.id === 'gemini-local') || store.data.providers.find(p => p.name === 'Gemini Web2API');
      store.saveProvider({ ...p, name: p?.name || 'Gemini Web2API', type: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: token, models: p?.models || ['gemini-3.6-flash'], defaultModel: p?.defaultModel || 'gemini-3.6-flash' });
    } });
    runner = new AgentRunner({ store, workspace, emit });
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    ipcMain.handle('desktop:invoke', async (event, method, args) => {
      const allowed = devUrl ? new URL(devUrl).href : pathToFileURL(entry).href;
      if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== allowed) throw new Error('Untrusted desktop request.');
      if (typeof method !== 'string' || (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args)))) throw new Error('Invalid desktop request.');
      return dispatch(method, args);
    });
    createWindow();
    websitePreparation = web2apiSetup.prepareStartup().catch(error => web2apiSetup.changed({ phase: 'error', error: error.message, message: error.message }));
    serviceStartup = startConfiguredServices({ store, gateway, browserConnector, bridge, bridges,
      startBridge: async profile => {
        await websitePreparation;
        if (profile.id === web2apiSetup.status().bridgeId && profile.launchMode === 'managed') {
          try {
            await discoverModels(store.provider(profile.providerId), { timeoutMs: 2500 });
            return await bridges.check(profile.id);
          } catch (error) {
            if ([401, 403].includes(error.status)) {
              const message = 'The website service rejected the saved local key. Click Connect & start to check its setup.';
              web2apiSetup.changed({ phase: 'error', error: message, message });
              throw new Error(message);
            }
          }
        }
        return bridges.start(profile.id);
      },
      gatewayPort: !app.isPackaged && process.env.GRAVITY_TEST_GATEWAY_PORT === '0' ? 0 : undefined, onChange: changed });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch(error => { dialog.showErrorBox('Gravity could not start', error.message); app.quit(); });
}
app.on('before-quit', event => {
  if (quitting || !runner) return;
  event.preventDefault(); quitting = true;
  for (const operation of terminals.values()) operation.stop();
  Promise.allSettled([runner.shutdown(), web2apiSetup.close(), gateway.stop(), bridge.stop(), bridges.shutdown(), browserConnector.shutdown()]).then(() => serviceStartup).finally(() => app.quit());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
