import fs from 'node:fs';
import path from 'node:path';

export function userDataDirectory(appData, env = process.env, exists = fs.existsSync) {
  const override = env.GRAVITY_DATA_DIR || env.ANTIGRAVITY_DATA_DIR;
  if (override) return path.resolve(override);
  // Keep existing encryption and loaded extension folders attached to the same
  // profile. Fresh installations use the new product name.
  const legacy = path.join(appData, 'Antigravity Studio');
  return exists(path.join(legacy, 'state.json')) ? legacy : path.join(appData, 'Gravity');
}

export function importEnvironmentProviders(store, env = process.env) {
  const presets = [
    { variable: 'GEMINI_API_KEY', name: 'Google Gemini', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
    { variable: 'OPENAI_API_KEY', name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { variable: 'ANTHROPIC_API_KEY', name: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
  ];
  for (const preset of presets) {
    if (!env[preset.variable]) continue;
    const current = store.data.providers.find(provider => provider.type === preset.type && provider.baseUrl.replace(/\/$/, '') === preset.baseUrl);
    if (current?.encryptedApiKey) continue;
    store.saveProvider({ ...current, name: current?.name || preset.name, type: preset.type, baseUrl: preset.baseUrl,
      models: current?.models || [preset.model], defaultModel: current?.defaultModel || preset.model, apiKey: env[preset.variable] });
  }
}

export async function startConfiguredServices({ store, gateway, browserConnector, bridge, bridges, gatewayPort, onChange = () => {} }) {
  const settings = store.data.settings;
  const operations = [];
  const start = (service, operation) => operations.push(Promise.resolve().then(operation).catch(error => {
    // Readiness failures remain visible in the service's own Settings section.
    if (service?.info) service.info.error = error.message;
    onChange();
    throw error;
  }));
  if (settings.gatewayAutoStart) start(gateway, () => gateway.start({ port: gatewayPort ?? settings.gatewayPort, token: settings.gatewayToken }));
  if (settings.browserAutoStart) start(browserConnector, () => browserConnector.start());
  const profiles = settings.bridgesAutoStart ? store.data.bridgeProfiles : [];
  for (const profile of profiles) start(null, () => bridges.start(profile.id));
  const geminiProvider = store.data.providers.find(provider => provider.id === 'gemini-local' || provider.name === 'Gemini Web2API');
  const geminiHasProfile = profiles.some(profile => {
    if (profile.providerId === geminiProvider?.id) return true;
    if (profile.launchMode !== 'managed') return false;
    try { return Number(new URL(store.data.providers.find(provider => provider.id === profile.providerId)?.baseUrl).port) === settings.bridgePort; }
    catch { return false; }
  });
  if (settings.bridgeAutoStart && settings.bridgeExecutable && settings.bridgeConfig && !geminiHasProfile) {
    start(bridge, () => bridge.start({ executable: settings.bridgeExecutable, config: settings.bridgeConfig, port: settings.bridgePort }));
  }
  // No service holds up another one, and a missing optional adapter never keeps
  // the desktop or its other connections from opening.
  return Promise.allSettled(operations);
}
