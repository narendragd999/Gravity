import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, ChevronRight, Chrome, Cpu, Loader2, Radio, Server, Settings2, XCircle } from 'lucide-react';
import { AppState, Invoke, Provider, errorText, modelLabel, responseCheckFor } from './types';
import './ConnectionPanels.css';

export type ConnectionPage = 'browser' | 'providers' | 'bridge' | 'gateway';
type Props = {
  state: AppState; call: Invoke;
  onChoose(page: ConnectionPage, providerId?: string): void;
  onUseProvider?(id: string, model: string): Promise<void>;
  disabled?: boolean;
};

function checkTime(value?: string) {
  const time = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return 'Time unavailable';
  return new Date(time).toLocaleString();
}
function checkAge(value?: string) {
  const time = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`;
  return `${Math.floor(minutes / 1440)} day${minutes >= 2880 ? 's' : ''} ago`;
}
function failedCheck(code?: string) {
  if (code === 'empty_response') return 'The model returned no usable answer. Check its model setting or try normal Chrome.';
  if (code === 'connection_refused') return 'The model service is stopped or its address is incorrect. Open its connection settings.';
  if (code?.startsWith('browser_')) return 'Open Browser Connector to check the Chrome extension and the signed-in website.';
  if (code === 'unsupported_response_format' || code === 'invalid_response' || code === 'invalid_stream') return 'The provider response could not be read. Check this connection or try normal Chrome.';
  if (code === 'timeout' || code === 'upstream_timeout') return 'The response test timed out. Check the model service or complete the website check yourself.';
  return 'The response test failed. Open this connection to check the selected model and service.';
}
function pageFor(provider: Provider, state: AppState): ConnectionPage {
  if (provider.managedBy === 'browser-connector') return 'browser';
  if (provider.managedBy === 'web2api' || provider.id === 'gemini-local' || provider.name === 'Gemini Web2API'
    || state.bridgeProfiles.some(profile => profile.providerId === provider.id)) return 'bridge';
  return 'providers';
}

export default function ConnectionsOverview({ state, call, onChoose, onUseProvider, disabled }: Props) {
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = async (key: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(key); setNotice(undefined);
    try { await operation(); }
    catch (error) { if (alive.current) setNotice({ text: errorText(error), error: true }); }
    finally { if (alive.current) setBusy(''); }
  };
  const test = (provider: Provider) => run(`${provider.id}:test`, async () => {
    const result = await call<{ ok: boolean; code?: string }>('provider:test', { id: provider.id, model: provider.defaultModel });
    if (alive.current) setNotice({ text: result.ok ? 'A model response was received. The result and time are saved.' : failedCheck(result.code), error: !result.ok });
  });
  const keyProvider = state.providers.find(provider => provider.managedBy !== 'browser-connector' && provider.managedBy !== 'web2api' && provider.hasApiKey);
  const localApiUrl = `http://127.0.0.1:${state.gateway.port || state.settings.gatewayPort}/v1`;

  return <div className="connections-overview" data-testid="connections-overview">
    <div className="section-eyebrow">YOUR MODEL CONNECTIONS</div>
    <h2>Connections</h2>
    <p className="muted">Choose how Gravity gets an AI response. You can also share these models with another app on your computer.</p>

    <section className="connection-direction" aria-labelledby="gravity-model-heading">
      <div className="connection-section-heading"><Cpu size={18} /><h3 id="gravity-model-heading">Use AI in Gravity</h3></div>
      <div className="setup-choice-grid">
        <button className="setup-choice recommended" data-testid="setup-browser" onClick={() => onChoose('browser')}>
          <Chrome size={24} /><span className="recommended">Recommended for signed-in websites</span>
          <strong>Use your normal Chrome</strong>
          <span>Connect the accounts already signed into Chrome. Set up and pair the Gravity extension once.</span>
          <span className="text-btn">Open Chrome connections <ChevronRight size={14} /></span>
        </button>
        <button className="setup-choice" data-testid="setup-api-key" onClick={() => onChoose('providers', keyProvider?.id)}>
          <Cpu size={24} /><span className="optional">API accounts and local models</span>
          <strong>Connect an API or local model</strong>
          <span>Use your provider account, Ollama or LM Studio. A local model needs its server running.</span>
          <span className="text-btn">Open provider settings <ChevronRight size={14} /></span>
        </button>
        <button className="setup-choice web2api" data-testid="setup-web2api" onClick={() => onChoose('bridge')}>
          <Server size={24} /><span className="optional">Saved website profile and app-managed startup</span>
          <strong>Use a separate website profile</strong>
          <span>Gravity opens its own saved Chrome or Edge profile. Sign in there once; later requests reuse that profile.</span>
          <span className="text-btn">Open website and bridge settings <ChevronRight size={14} /></span>
        </button>
      </div>
    </section>

    <section className="saved-connections" aria-labelledby="saved-connections-heading">
      <div className="connection-section-heading"><Settings2 size={17} /><h3 id="saved-connections-heading">Saved connections</h3></div>
      <p className="field-help">Test response checks actual generation. Its result stays saved with the selected model and time.</p>
      {!state.providers.length && <p className="connection-empty">Choose a connection above to add your first model.</p>}
      <div className="saved-connection-list">{state.providers.map(provider => {
        const check = responseCheckFor(provider, provider.defaultModel), page = pageFor(provider, state);
        const Icon = page === 'browser' ? Chrome : page === 'bridge' ? Server : Cpu;
        return <article className="saved-connection" key={provider.id} data-testid="saved-connection" data-provider-id={provider.id}>
          <div className="saved-connection-top"><Icon size={18} /><div className="saved-connection-identity"><strong>{provider.name}</strong><span>{provider.defaultModel ? modelLabel(provider.defaultModel) : 'Choose a default model'}</span></div>
            <span className={`connection-check-label ${check ? check.ok ? 'passed' : 'failed' : ''}`}>
              {check ? check.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} /> : <span className="connection-status-dot" />}
              {check ? check.ok ? 'Last test passed' : 'Last test failed' : 'Response not tested'}
            </span>
          </div>
          <div className="saved-connection-bottom"><span className="connection-method">{page === 'browser' ? 'Normal Chrome' : page === 'bridge' ? 'Website or local bridge' : 'API or local model'}</span>
            <div className="saved-connection-actions">
              <button className="text-btn" disabled={!!busy || !!disabled || !provider.defaultModel} data-testid="connection-test-response" onClick={() => void test(provider)}>{busy === `${provider.id}:test` && <Loader2 size={13} className="spin" />}Test response</button>
              {onUseProvider && <button className="text-btn" disabled={!!busy || !!disabled || !provider.defaultModel} data-testid="connection-use-provider" onClick={() => void run(`${provider.id}:use`, () => onUseProvider(provider.id, provider.defaultModel))}>Use in chat</button>}
              <button className="text-btn" data-testid="connection-configure" onClick={() => onChoose(page, provider.id)}>Configure <ChevronRight size={13} /></button>
            </div>
          </div>
          {check && <details className="connection-check-details" data-testid="connection-response-history"><summary>Response check · {checkAge(check.checkedAt)}</summary>
            <dl><dt>Checked</dt><dd><time dateTime={check.checkedAt}>{checkTime(check.checkedAt)}</time></dd>
              {typeof check.durationMs === 'number' && Number.isFinite(check.durationMs) && <><dt>Response time</dt><dd>{Math.max(0, check.durationMs / 1000).toFixed(1)} seconds</dd></>}
              {check.lastSuccessAt && <><dt>Last success</dt><dd>{checkTime(check.lastSuccessAt)}</dd></>}
              {check.lastFailureAt && <><dt>Last failure</dt><dd>{checkTime(check.lastFailureAt)}</dd></>}
            </dl>
            {!check.ok && <p className="connection-check-error">{failedCheck(check.code)}</p>}
          </details>}
        </article>;
      })}</div>
    </section>

    <section className="connection-sharing" aria-labelledby="share-model-heading">
      <div className="connection-section-heading"><Radio size={18} /><h3 id="share-model-heading">Share models with other apps</h3><span className="connection-optional">Optional</span></div>
      <p>Use Gravity's local API when another app needs the models you've connected here. Provider settings get answers for Gravity; this API accepts requests from the other app.</p>
      <div className="connection-route" aria-label="Request route"><span>Other app</span><ArrowRight size={14} /><span>Gravity local API</span><ArrowRight size={14} /><span>Your provider</span><ArrowRight size={14} /><span>AI response</span></div>
      <div className="connection-sharing-bottom"><code>{localApiUrl}</code><button className="secondary-btn" data-testid="connections-share-api" onClick={() => onChoose('gateway')}>Open API for other apps <ChevronRight size={14} /></button></div>
      <p className="field-help">If you only chat inside Gravity, choose a working model above. The local API uses its own access key.</p>
    </section>
    {notice && <div className={`notice ${notice.error ? 'error' : 'success'}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <XCircle size={15} /> : <CheckCircle2 size={15} />}<span>{notice.text}</span></div>}
  </div>;
}
