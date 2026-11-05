import { useState } from 'react';
import { ArrowUpRight, CheckCircle2, ChevronDown, Cpu, Globe2, Loader2, Play, RefreshCw, Settings2, XCircle } from 'lucide-react';
import { AppState, Conversation, Invoke, Provider, ProviderCapabilities, errorText, modelLabel, websiteForModel, websiteNames } from './types';

export default function ChatConnection({ provider, model, state, conversation, capabilities, disabled, call, onSettings, onBrowserSetup, onWebsiteSetup, onUseProvider }: {
  provider?: Provider; model: string; state: AppState; conversation?: Conversation; capabilities?: ProviderCapabilities;
  disabled: boolean; call: Invoke; onSettings(): void; onBrowserSetup(): void; onWebsiteSetup(): void;
  onUseProvider(providerId: string, model: string): Promise<void>;
}) {
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  if (!provider) return null;
  const connector = state.browserConnector;
  const setup = state.web2apiSetup;
  const browser = provider.managedBy === 'browser-connector';
  const website = websiteForModel(model);
  const site = connector.sites.find(site => site.id === website);
  const profile = state.bridgeProfiles.find(item => item.providerId === provider.id);
  const runtime = state.bridges.find(item => item.id === profile?.id);
  const websiteService = !!website && !browser && (provider.managedBy === 'web2api' || setup?.providerId === provider.id);
  // One service serves several websites. Account errors belong to the attempted website.
  const relevantSetup = websiteService && (!setup?.siteId || setup.siteId === website || setup.recoveryAction === 'start');
  const savedSession = !!setup?.sites.find(item => item.id === website)?.enabled;
  const failed = conversation?.status === 'error';
  let status = 'API configured';
  let issue = '';
  let starting = false;
  if (browser) {
    status = !connector.running ? 'Connector stopped' : !connector.paired ? 'Extension approval needed' : connector.extension?.compatible === false ? 'Extension update needed' : !site?.connected ? 'Website tab needed' : site.error ? 'Sign-in or website attention needed' : site.busy ? 'Website is working' : 'Website tab detected';
    issue = !connector.running ? 'Start the connector to use this connection.' : connector.error || (!connector.paired ? 'Connect the Chrome extension and approve it in setup.' : connector.extension?.error || (!site?.connected ? 'Open the website in Chrome and sign in with the connected extension.' : site.error || ''));
  } else if (websiteService) {
    starting = !!runtime?.starting || (!!setup?.busy && !!relevantSetup);
    status = starting ? 'Website setup in progress' : relevantSetup && setup?.error ? 'Website connection needs attention' : !savedSession ? 'Website sign-in needed' : runtime?.state === 'ready' ? 'Website service ready' : 'Website service stopped';
    issue = relevantSetup && setup?.error ? setup.error : !savedSession ? `Sign in to ${websiteNames[website!]} to save its session.` : runtime?.error || (runtime?.state !== 'ready' && !starting ? 'Start the saved website connection.' : '');
  } else if (profile) {
    starting = !!runtime?.starting;
    status = runtime?.state === 'ready' ? 'Adapter reachable' : starting ? 'Adapter starting' : 'Adapter stopped';
    issue = runtime?.error || (!runtime?.running && !starting ? 'Start or check this adapter to connect.' : '');
  }
  const failure = failed ? conversation?.failure?.message : '';
  const lastTest = provider.lastTest?.model === model ? provider.lastTest : undefined;
  const action = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name); setNotice('');
    try { const result = await fn(); if (result && typeof result === 'object' && 'error' in result && result.error) throw new Error(String(result.error)); setNotice(name === 'switch' ? 'Connection selected. Review your message, then press Send.' : 'Action complete. Check the connection above, then press Send when ready.'); }
    catch (error) { setNotice(errorText(error)); }
    finally { setBusy(''); }
  };
  const prepare = () => action('prepare', async () => {
    if (browser) { if (!connector.running) await call('browser:start'); if (website) await call('browser:openSite', { siteId: website }); }
    else if (websiteService) { if (!savedSession) onWebsiteSetup(); return call('web2api:connect', { siteId: website }); }
    else if (profile) await call(profile.launchMode === 'managed' ? 'bridges:start' : 'bridges:check', { id: profile.id });
    else onSettings();
  });
  let local = false;
  try { local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(provider.baseUrl).hostname); } catch { /* Saved URL validation belongs to settings. */ }
  const chrome = state.providers.find(p => p.managedBy === 'browser-connector' && p.models.includes('claude-web'));
  const offerChrome = failed && local && !browser && /^claude[-_]/i.test(model) && chrome;
  const alternatives = state.providers.flatMap(item => item.models.map(name => ({ provider: item, model: name }))).filter(item => {
    if (item.provider.id === provider.id && item.model === model) return false;
    if (item.provider.managedBy === 'browser-connector') return connector.running && connector.paired && connector.sites.some(site => site.id === websiteForModel(item.model) && site.connected && !site.busy && !site.error);
    const bridge = state.bridgeProfiles.find(profile => profile.providerId === item.provider.id);
    return bridge ? state.bridges.some(runtime => runtime.id === bridge.id && runtime.state === 'ready') : item.provider.hasApiKey;
  }).slice(0, 3);
  return <div className={`chat-connection ${failed || issue || lastTest?.ok === false ? 'needs-attention' : ''}`} data-testid="chat-connection">
    <details className="chat-connection-disclosure" data-testid="chat-connection-details">
      <summary className="chat-connection-summary">
        <span className="chat-connection-status" data-testid="chat-connection-status" aria-live="polite">{starting ? <Loader2 size={12} className="spin" /> : <span className={`status-dot ${!issue && (browser || runtime?.state === 'ready') ? 'online' : ''}`} />}<span>{status}</span>{capabilities && <small>{capabilities.images ? 'Images supported' : 'Text only'}</small>}</span>
        <span className="chat-connection-more">Connection details<ChevronDown size={12} /></span>
      </summary>
      <div className="chat-connection-body">
        <div className="chat-connection-heading"><Cpu size={12} /><span><strong>{provider.name}</strong> · {modelLabel(model) || 'Choose a model'}</span><button type="button" data-testid="chat-change-provider" className="text-btn" onClick={onSettings}><Settings2 size={12} />Change</button></div>
        {website && <p className="field-help">Uses the model selected on {websiteNames[website]}.</p>}
        {capabilities && (capabilities.streaming === 'buffered' || capabilities.streaming === 'live' || capabilities.toolMode === 'emulated') && <p className="field-help">{capabilities.streaming === 'buffered' ? 'The reply appears when complete.' : capabilities.streaming === 'live' ? 'Responses stream as they arrive.' : ''}{capabilities.toolMode === 'emulated' ? ' Project actions depend on the model returning a valid action.' : ''}</p>}
        {lastTest ? <p className={`chat-response-check ${lastTest.ok ? '' : 'error'}`} data-testid="chat-last-response-check">{lastTest.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}Response {lastTest.ok ? 'verified' : 'test failed'} · {new Date(lastTest.checkedAt).toLocaleString()}{lastTest.durationMs !== undefined && ` · ${(lastTest.durationMs / 1000).toFixed(1)}s`}</p> : <p className="field-help">No response test recorded for this model. Test it in connection settings.</p>}
      </div>
    </details>
    {lastTest?.ok === false && !failed && !issue && <div className="chat-response-failure" role="status"><XCircle size={12} /><span>The last model test failed.</span><button type="button" className="text-btn" onClick={onSettings}>Review connection</button></div>}
    {(failed || issue) && <div className="chat-connection-detail">
      {failure && <p role="alert">{failure}</p>}{issue && <p>{issue}</p>}{failed && !failure && <p>The last request failed. Prepare the connection before sending again.</p>}
      <div className="chat-connection-actions">
        {(browser || websiteService || profile) && <button type="button" className="secondary-btn" data-testid="chat-prepare-connection" disabled={disabled || !!busy || starting} onClick={() => void prepare()}>{busy === 'prepare' ? <Loader2 size={12} className="spin" /> : runtime?.running || connector.running && browser ? <RefreshCw size={12} /> : <Play size={12} />}{websiteService && !savedSession ? 'Connect website' : browser && connector.running ? 'Open website' : failed ? 'Prepare connection' : 'Start connection'}</button>}
        {websiteService && savedSession && <button type="button" className="secondary-btn" data-testid="chat-sign-in-again" disabled={disabled || !!busy || starting} onClick={() => void action('login', () => { onWebsiteSetup(); return call('web2api:connect', { siteId: website, forceLogin: true }); })}><Globe2 size={12} />Sign in again</button>}
        {offerChrome && <button type="button" className="secondary-btn" data-testid="use-chrome-claude" disabled={disabled || !!busy} onClick={() => void action('switch', () => onUseProvider(chrome.id, 'claude-web'))}>Use Claude in Chrome</button>}
        <button type="button" className="text-btn" onClick={browser ? onBrowserSetup : websiteService ? onWebsiteSetup : onSettings}><ArrowUpRight size={12} />Open {browser ? 'browser' : websiteService ? 'website' : 'connection'} setup</button>
      </div>
      {failed && alternatives.length > 0 && <div className="chat-connection-actions">{alternatives.map(item => <button type="button" className="text-btn" key={`${item.provider.id}:${item.model}`} disabled={disabled || !!busy} onClick={() => void action('switch', () => onUseProvider(item.provider.id, item.model))}>Use {modelLabel(item.model)}</button>)}</div>}
      {failed && <p className="field-help">Recovery keeps your draft and chat history. Check whether the website already received your message before sending it again.</p>}
    </div>}
    {notice && <p className="chat-connection-notice" role="status">{notice}</p>}
  </div>;
}
