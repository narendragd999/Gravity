import { complete, ProviderError, safeGenerationEndpoint } from './providers.mjs';
import { BROWSER_SITES } from './browser-connector.mjs';

const TEST_TIMEOUT_MS = 90_000;
const TEST_PROMPT = 'Reply with only OK.';

function redact(value, provider) {
  let result = String(value ?? '');
  let queryValues = [];
  try { queryValues = [...new URL(provider.baseUrl).searchParams.values()]; } catch { /* Invalid URLs are reported by the provider adapter. */ }
  for (const secret of [provider.apiKey, ...Object.values(provider.headers || {}), ...queryValues]) {
    if (typeof secret === 'string' && secret.length) result = result.split(secret).join('[redacted]');
  }
  return result.slice(0, 1800);
}

function checkBrowserReadiness(model, status) {
  if (!status?.running) throw new ProviderError('Start the Browser connector in Settings → Browser Connector, then test again.', 503, 'browser_not_running');
  if (status.error) throw new ProviderError(`The Browser connector needs attention: ${status.error} Open Settings → Browser Connector.`, 503, 'browser_error');
  if (!status.paired) throw new ProviderError('Pair and approve the Chrome extension in Settings → Browser Connector, then test again.', 503, 'browser_not_paired');
  const route = BROWSER_SITES.find(site => site.model === model);
  if (!route) throw new ProviderError('Choose a browser model such as claude-web from this provider’s Model IDs.', 400, 'browser_unknown_model');
  const site = status.sites?.find(site => site.id === route.id);
  if (site?.error) throw new ProviderError(`${route.name} needs attention: ${site.error} Reconnect its tab in the Chrome extension, then test again.`, 503, 'browser_site_error');
  if (!site?.connected) throw new ProviderError(`Open and sign in to ${route.name} in Chrome, then connect its tab in the extension and test again.`, 503, 'browser_site_not_connected');
  if (site.busy) throw new ProviderError(`${route.name} is busy. Wait for its current request to finish, then test again.`, 409, 'browser_site_busy');
}

function responseText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text' || part?.type === 'output_text')
    .map(part => typeof part.text === 'string' ? part.text : '').join('\n').trim();
}

// This deliberately has no conversation, project, system prompt, or tool input.
export async function testProviderGeneration(provider, { model, browserStatus, signal, timeoutMs } = {}) {
  const selectedModel = typeof model === 'string' && model.trim()
    || provider.defaultModel?.trim() || provider.models?.find(model => typeof model === 'string' && model.trim())?.trim() || '';
  const result = { providerId: provider.id, providerName: redact(provider.name || 'Provider', provider), model: redact(selectedModel, provider), endpoint: '' };
  try {
    if (model !== undefined && typeof model !== 'string') throw new ProviderError('Choose a model ID before testing generation.', 400, 'invalid_model');
    if (!selectedModel) throw new ProviderError('Enter a Model ID or discover models, save the provider, then test generation.', 400, 'missing_model');
    result.endpoint = redact(safeGenerationEndpoint(provider, selectedModel), provider);
    if (provider.managedBy === 'browser-connector') checkBrowserReadiness(selectedModel, browserStatus);
    const maximumTimeout = ['browser-connector', 'web2api'].includes(provider.managedBy) ? 180000 : TEST_TIMEOUT_MS;
    const response = await complete(provider, {
      model: selectedModel,
      messages: [{ role: 'user', content: TEST_PROMPT }],
      max_tokens: 128,
      stream: false,
    }, { signal, timeoutMs: Math.min(maximumTimeout, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : maximumTimeout) });
    if (!responseText(response.choices?.[0]?.message?.content)) throw new ProviderError('The provider returned no text. Generation was not verified; check the selected model and bridge logs.', 502, 'empty_response');
    return { ...result, ok: true, message: `Generation verified for ${result.providerName} (${result.model}) at ${result.endpoint}. Received a text response.` };
  } catch (error) {
    const message = error.name === 'TimeoutError'
      ? 'The generation test timed out. Check the selected model and bridge, then try again.'
      : error.message || 'Provider test failed.';
    const context = `${result.providerName}${result.model ? ` (${result.model})` : ''}${result.endpoint ? ` at ${result.endpoint}` : ''}`;
    return { ...result, ok: false, code: error.name === 'TimeoutError' ? 'timeout' : redact(error.code || 'provider_test_failed', provider),
      message: `${context}: ${redact(message, provider)}` };
  }
}
