const websiteModels = /^(?:claude|chatgpt|deepseek|qwen|zai|gemini)-web(?:-|$)/;

export function providerCapabilities(provider, model = provider?.defaultModel || '') {
  let includedClaude = false;
  try { const url = new URL(provider?.baseUrl); includedClaude = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && /claude.*web2api/i.test(provider?.name || ''); } catch { /* Unknown provider stays native. */ }
  const website = provider?.managedBy === 'browser-connector' || provider?.managedBy === 'web2api'
    || includedClaude || websiteModels.test(model) || (provider?.models?.length && provider.models.every(value => websiteModels.test(value)));
  if (website) return { images: false, tools: true, toolMode: 'emulated', streaming: 'buffered' };
  return { images: provider?.capabilities?.images !== false, tools: provider?.capabilities?.tools !== false,
    toolMode: 'native', streaming: provider?.capabilities?.streaming || 'live' };
}

export function cleanProviderError(error) {
  let message = String(error?.message || 'The connection could not complete this request.');
  message = message.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^(?:ProviderError|Error):\s*/i, '');
  // The error summary is user-facing; URLs with query credentials are not.
  message = message.replace(/https?:\/\/[^\s)]+/g, value => {
    try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return '[website]'; }
  });
  return message.slice(0, 1200);
}
