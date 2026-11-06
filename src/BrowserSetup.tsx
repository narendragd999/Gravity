import { useState } from 'react';
import { ArrowUpRight, Check, CheckCircle2, Chrome, FolderOpen, Link2, Loader2, Play, ShieldCheck, Square, Unplug, X } from 'lucide-react';
import { AppState, BrowserSiteId, Invoke, errorText, initialState, responseCheckFor } from './types';

const websites: { id: BrowserSiteId; name: string; model: string; mark: string }[] = [
  { id: 'claude', name: 'Claude', model: 'claude-web', mark: 'C' },
  { id: 'chatgpt', name: 'ChatGPT', model: 'chatgpt-web', mark: 'G' },
  { id: 'deepseek', name: 'DeepSeek', model: 'deepseek-web', mark: 'D' },
  { id: 'qwen', name: 'Qwen', model: 'qwen-web', mark: 'Q' },
  { id: 'zai', name: 'Z.ai', model: 'zai-web', mark: 'Z' },
  { id: 'gemini', name: 'Gemini', model: 'gemini-web', mark: '✦' },
];

export default function BrowserSetup({ state, call, onUseProvider, modelSelectionDisabled }: { state: AppState; call: Invoke; onUseProvider?(providerId: string, model: string): Promise<void>; modelSelectionDisabled?: boolean }) {
  const connector = state.browserConnector || initialState.browserConnector;
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ text: string; error?: boolean; step?: string } | null>(null);
  const [extensionPath, setExtensionPath] = useState('');
  const connected = connector.running && connector.paired && connector.extension?.compatible !== false;
  const provider = state.providers.find(item => item.managedBy === 'browser-connector');
  const pending = connector.pendingPairings || [];
  const task = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setNotice(null);
    try { await fn(); } catch (error) { setNotice({ text: errorText(error), error: true, step: label }); }
    finally { setBusy(''); }
  };

  return <div className="browser-setup" data-testid="browser-setup">
    <div className="browser-intro"><div className="browser-intro-icon"><Chrome size={23} /></div><div><h3>{connected ? 'Your Chrome extension is paired.' : 'Use the accounts you already have.'}</h3><p>{connected ? 'Open a website below, sign in if needed, and use it in your chat.' : 'One extension connects Claude, ChatGPT, DeepSeek, Qwen, Z.ai, and Gemini. No API key or configuration file needed.'}</p></div></div>
    <div className="browser-service-controls"><span className={`browser-status ${connector.running ? 'online' : ''}`}><i />{connector.running ? 'Connector running' : 'Connector stopped'}</span>{!connector.running && <button data-testid="browser-start" className="primary-btn" disabled={!!busy} onClick={() => task('start', async () => { await call('browser:start'); })}>{busy === 'start' ? <Loader2 size={14} className="spin" /> : <Play size={14} />}Start connector</button>}</div>
    {connector.extension && <p data-testid="browser-extension-version" className="browser-step-note">Active Chrome extension: {connector.extension.version}{connector.extension.compatible ? ' · Compatible' : ' · Update required: open extension setup, then click Reload in Chrome.'}</p>}
    {connector.error && <div data-testid="browser-connector-error" className="notice error" role="alert">{connector.error}</div>}
    <details className="advanced browser-installation" open={!connected || pending.length > 0}>
      <summary>{connected ? 'Extension setup & pairing' : 'Set up Chrome once'}</summary>
      <ol className="browser-steps">
        <li><span className={`browser-step-number ${connected ? 'complete' : ''}`}>{connected ? <Check size={13} /> : '1'}</span><div className="browser-step-content">
          <h4>Install the Chrome extension</h4>
          <p>Choose <strong>Open extension setup</strong>. In Chrome, turn on <strong>Developer mode</strong>, click <strong>Load unpacked</strong>, and select the prepared folder. The path is copied for you.</p>
          <div className="browser-step-actions"><button data-testid="browser-install" className="secondary-btn" disabled={!!busy} onClick={() => task('install', async () => { const result = await call<{ path: string; updatedPaths?: string[]; warning?: string }>('browser:openSetup'); setExtensionPath(result.path); setNotice({ text: result.warning || 'Extension folder ready. In Chrome, use Load unpacked and paste the folder below. If the extension is already installed, click its Reload button instead.', error: !!result.warning, step: 'install' }); })}>{busy === 'install' ? <Loader2 size={14} className="spin" /> : <FolderOpen size={14} />}Open extension setup<ArrowUpRight size={13} /></button></div>
          {notice?.step === 'install' && <div role={notice.error ? 'alert' : 'status'} className={`notice ${notice.error ? 'error' : 'success'}`}>{notice.text}</div>}
          {extensionPath && <code data-testid="browser-extension-path" className="browser-endpoint">{extensionPath}</code>}
          <p className="browser-step-note">Chrome requires this one-time installation. For an update, use the same setup button and click Reload on Gravity Browser Connector in Chrome. Updated files take effect only after Chrome reloads the extension.</p>
        </div></li>
        <li><span className={`browser-step-number ${connected ? 'complete' : ''}`}>{connected ? <Check size={13} /> : '2'}</span><div className="browser-step-content">
          <div className="browser-step-heading"><h4>Connect and approve</h4>{connected && <span className="browser-status online"><i />Paired</span>}</div>
          <p>Open the extension in Chrome and choose <strong>Connect to app</strong>. Then approve its request here.</p>
          {pending.length > 0 && <div className="browser-pairings" aria-live="polite">{pending.map(pairing => <div className="browser-pairing" key={pairing.id}>
            <div className="browser-pairing-details"><ShieldCheck size={16} /><div><strong>Extension requesting access</strong><code title={pairing.extensionId}>{pairing.extensionId.length > 24 ? `${pairing.extensionId.slice(0, 12)}…${pairing.extensionId.slice(-8)}` : pairing.extensionId}</code></div></div>
            <button data-testid={`browser-approve-${pairing.id}`} data-pairing-id={pairing.id} className="primary-btn" disabled={!!busy || !connector.running} onClick={() => task(`approve:${pairing.id}`, async () => { await call('browser:approve', { id: pairing.id }); setNotice({ text: 'Extension approved. Open a website and use it in chat.' }); })}>{busy === `approve:${pairing.id}` ? <Loader2 size={14} className="spin" /> : <Link2 size={14} />}Approve connection</button>
          </div>)}</div>}
          {!connected && !pending.length && <div className="browser-awaiting"><Link2 size={14} />{connector.running ? 'Waiting for your extension connection request.' : 'Start the connector above, then connect the extension.'}</div>}
          {pending.length > 0 && <p className="browser-step-note">Approve the request you just started from your extension.</p>}
          {connector.paired && <div className="browser-step-actions"><button data-testid="browser-revoke" className="text-btn danger-text" disabled={!!busy} onClick={() => task('revoke', async () => { await call('browser:revoke'); setNotice({ text: 'Extension access revoked. Connect and approve it again to resume.' }); })}><Unplug size={14} />Revoke extension access</button></div>}
        </div></li>
      </ol>
    </details>
    <div className="setting-block"><h3>Choose a website</h3><p className="field-help">Open a website in the Chrome profile with the extension. Sign in there if prompted.</p>
      <div className="browser-sites">{websites.map(website => {
        const site = connector.sites?.find(item => item.id === website.id);
        const detected = connected && !!site?.connected;
        const working = connected && !!site?.busy;
        const siteError = connected ? site?.error : undefined;
        const testResult = responseCheckFor(provider, website.model);
        const status = !connected ? 'Connect extension first' : siteError ? 'Needs attention' : working ? 'Working' : detected ? 'Tab detected' : 'Open & sign in';
        return <article className={`browser-site ${detected ? 'detected' : ''}`} key={website.id}>
          <div className="browser-site-heading"><span className={`browser-site-mark ${website.id}`}>{website.mark}</span><div><h5>{website.name}</h5><small>Uses the model selected on the website</small></div></div>
          <span className={`browser-status ${working || detected ? 'online' : ''} ${siteError ? 'error' : ''}`} aria-live="polite">{working ? <Loader2 size={10} className="spin" /> : <i />}{status}</span>
          {siteError && <p className="browser-site-error" role="alert">{siteError}</p>}
          <button data-testid={`browser-site-${website.id}`} className="text-btn" disabled={!!busy} onClick={() => task(`site:${website.id}`, async () => { await call('browser:openSite', { siteId: website.id }); })}><ArrowUpRight size={13} />Open {website.name}</button>
          {onUseProvider && <button data-testid={`browser-use-${website.id}`} className="secondary-btn" disabled={!!busy || !!modelSelectionDisabled || !connected || !provider || !detected || working || !!siteError} onClick={() => task(`use:${website.id}`, async () => { await onUseProvider(provider!.id, website.model); })}><Check size={13} />Use in chat</button>}
          <button data-testid={`browser-test-${website.id}`} className="text-btn" disabled={!!busy || !connected || !provider || working} onClick={() => task(`test:${website.id}`, async () => { await call('provider:test', { id: provider!.id, model: website.model }); })}>{busy === `test:${website.id}` ? <Loader2 size={12} className="spin" /> : <CheckCircle2 size={12} />}{busy === `test:${website.id}` ? 'Testing…' : 'Test response'}</button>
          {testResult && <p data-testid={`browser-test-result-${website.id}`} role="status" className={`browser-site-test ${testResult.ok ? 'success' : 'error'}`}>{testResult.ok ? 'Response verified. ' : 'Response test failed. '}{testResult.message}<span>Checked {new Date(testResult.checkedAt).toLocaleString()}{testResult.durationMs !== undefined && ` · ${(testResult.durationMs / 1000).toFixed(1)}s`}</span></p>}
        </article>;
      })}</div><p className="field-help">Choose the actual model on each website. Test response sends a short message and checks for a reply; it may use account quota and appear in chat history.</p>
    </div>
    <details className="advanced"><summary>Connector settings</summary><label className="check-label"><input type="checkbox" checked={state.settings.browserAutoStart} disabled={!!busy} onChange={e => { const browserAutoStart = e.target.checked; void task('settings', async () => { await call('settings:save', { browserAutoStart }); }); }} />Start Browser Connector when Gravity opens</label><div className="browser-step-actions">{connector.running && <button data-testid="browser-stop" className="secondary-btn" disabled={!!busy} onClick={() => task('stop', async () => { await call('browser:stop'); setNotice({ text: 'Browser Connector stopped.' }); })}><Square size={14} />Stop connector</button>}</div>{connector.url && <code className="browser-endpoint">{connector.url}</code>}</details>
    {notice && notice.step !== 'install' && <div role="status" className={`notice ${notice.error ? 'error' : 'success'}`}>{notice.error ? <X size={16} /> : <CheckCircle2 size={16} />}<span>{notice.text}</span></div>}
  </div>;
}
