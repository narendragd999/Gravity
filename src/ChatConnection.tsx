import { Cpu, Settings2 } from 'lucide-react';
import { BrowserConnectorState, Provider } from './types';

export default function ChatConnection({ provider, model, providers, connector, failed, disabled, onSettings, onBrowserSetup, onUseProvider }: {
  provider?: Provider; model: string; providers: Provider[]; connector: BrowserConnectorState;
  failed: boolean; disabled: boolean; onSettings(): void; onBrowserSetup(): void;
  onUseProvider(providerId: string, model: string): void;
}) {
  if (!provider) return null;
  let local = false;
  let endpoint = provider.baseUrl;
  try { const url = new URL(provider.baseUrl); local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname); endpoint = `${url.host}${url.pathname}`; } catch { /* Settings validates saved URLs. */ }
  const browser = provider.managedBy === 'browser-connector';
  const site = connector.sites.find(site => `${site.id}-web` === model);
  const setupIssue = !browser ? '' : !connector.running ? 'Start the browser connector to use this model.'
    : connector.error ? connector.error
    : !connector.paired ? 'Connect the Chrome extension and approve it in Web2API bridges.'
    : !site?.connected ? 'Open this website in the Chrome profile with the extension installed, and sign in.'
    : site.error || '';
  const chrome = providers.find(p => p.managedBy === 'browser-connector' && p.models.includes('claude-web'));
  const offerChrome = failed && local && !browser && /^claude[-_]/i.test(model) && chrome;
  return <div className={`chat-connection ${failed || setupIssue ? 'needs-attention' : ''}`} data-testid="chat-connection">
    <div className="chat-connection-heading"><Cpu size={12} /><span>Using <strong>{provider.name}</strong> · {model || 'Choose a model'}</span><button type="button" data-testid="chat-change-provider" className="text-btn" onClick={onSettings}><Settings2 size={12} />Change</button></div>
    {(failed || setupIssue) && <div className="chat-connection-detail"><code>{endpoint}</code>{failed && !browser && <p>Test and select the provider you want this conversation to use in Settings.</p>}{setupIssue && <p>{setupIssue}</p>}
      <div className="chat-connection-actions">{offerChrome && <button type="button" className="secondary-btn" data-testid="use-chrome-claude" disabled={disabled} onClick={() => onUseProvider(chrome.id, 'claude-web')}>Use Claude in Chrome</button>}{setupIssue && <button type="button" className="text-btn" onClick={onBrowserSetup}>Open browser setup</button>}</div>
    </div>}
  </div>;
}
