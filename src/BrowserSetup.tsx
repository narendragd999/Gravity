import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, CheckCircle2, Chrome, FolderOpen, Link2, Loader2, Play, ShieldCheck, Square, Unplug, X } from 'lucide-react';
import { AppState, BrowserSiteId, Invoke, errorText, initialState } from './types';

const websites: { id: BrowserSiteId; name: string; model: string; mark: string }[] = [
  { id: 'claude', name: 'Claude', model: 'claude-web', mark: 'C' },
  { id: 'chatgpt', name: 'ChatGPT', model: 'chatgpt-web', mark: 'G' },
  { id: 'deepseek', name: 'DeepSeek', model: 'deepseek-web', mark: 'D' },
  { id: 'qwen', name: 'Qwen', model: 'qwen-web', mark: 'Q' },
  { id: 'zai', name: 'Z.ai', model: 'zai-web', mark: 'Z' },
  { id: 'gemini', name: 'Gemini', model: 'gemini-web', mark: '✦' },
];

export default function BrowserSetup({ state, call }: { state: AppState; call: Invoke }) {
  const connector = state.browserConnector || initialState.browserConnector;
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ text: string; error?: boolean; step?: string } | null>(null);
  const [extensionPath, setExtensionPath] = useState('');
  const [siteTests, setSiteTests] = useState<Partial<Record<BrowserSiteId, { ok: boolean; message: string }>>>({});
  const connected = connector.running && connector.paired && connector.extension?.compatible !== false;
  const provider = state.providers.find(item => item.managedBy === 'browser-connector');
  const pending = connector.pendingPairings || [];
  useEffect(() => { setSiteTests({}); }, [connector.running, connector.paired, connector.url, connector.extension?.compatible]);
  const task = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setNotice(null);
    try { await fn(); } catch (error) { setNotice({ text: errorText(error), error: true, step: label }); }
    finally { setBusy(''); }
  };

  return <div className="browser-setup" data-testid="browser-setup">
    <div className="browser-intro"><div className="browser-intro-icon"><Chrome size={23} /></div><div><h3>Use your website accounts in Chrome.</h3><p>The companion extension uses the Chrome profile where you install it. Keep your website tabs open and sign in there when needed.</p></div></div>
    <p className="browser-simple-setup">No Python, Git, config-file editing, or cookie export.</p>
    {connector.error && <div data-testid="browser-connector-error" className="notice error" role="alert">{connector.error}</div>}
    <ol className="browser-steps">
      <li>
        <span className={`browser-step-number ${connector.running ? 'complete' : ''}`}>{connector.running ? <Check size={13} /> : '1'}</span>
        <div className="browser-step-content">
          <div className="browser-step-heading"><h4>Start the browser connector</h4><span className={`browser-status ${connector.running ? 'online' : ''}`}><i />{connector.running ? 'Running' : 'Stopped'}</span></div>
          <p>The app creates the provider and all six website model entries automatically.</p>
          <div className="browser-step-actions">
            <button data-testid="browser-start" className="primary-btn" disabled={!!busy || connector.running} onClick={() => task('start', async () => { await call('browser:start'); setNotice({ text: 'Browser connector started. Install and connect the companion extension next.' }); })}>{busy === 'start' ? <Loader2 size={14} className="spin" /> : <Play size={14} />}{connector.running ? 'Connector started' : 'Start browser connector'}</button>
            {connector.running && <button data-testid="browser-stop" className="secondary-btn" disabled={!!busy} onClick={() => task('stop', async () => { await call('browser:stop'); setNotice({ text: 'Browser connector stopped.' }); })}>{busy === 'stop' ? <Loader2 size={14} className="spin" /> : <Square size={14} />}Stop</button>}
          </div>
          {connector.running && connector.url && <code className="browser-endpoint">{connector.url}</code>}
        </div>
      </li>
      <li>
        <span className="browser-step-number">2</span>
        <div className="browser-step-content">
          <h4>Install or update the Chrome extension</h4>
          <p>Open setup to prepare or update the extension files. In Chrome, enable <strong>Developer mode</strong>. For an existing installation click its <strong>Reload</strong> button; for a first installation choose <strong>Load unpacked</strong> and select the folder shown below.</p>
          {connector.extension && <p data-testid="browser-extension-version" className="browser-step-note">Detected extension: {connector.extension.version}{connector.extension.compatible ? ' · Compatible' : ' · Update required'}</p>}
          <div className="browser-step-actions"><button data-testid="browser-install" className="secondary-btn" disabled={!!busy} onClick={() => task('install', async () => { const result = await call<{ path: string; updatedPaths?: string[]; warning?: string }>('browser:openSetup'); setExtensionPath(result.path); setNotice({ text: result.warning || 'Extension files are updated. Open chrome://extensions/ and click Reload on Antigravity Studio Browser Connector. For a first installation, use Load unpacked and select the folder below. Its path is copied to your clipboard.', error: !!result.warning, step: 'install' }); })}>{busy === 'install' ? <Loader2 size={14} className="spin" /> : <FolderOpen size={14} />}Open extension setup<ArrowUpRight size={13} /></button></div>
          {notice?.step === 'install' && <div role={notice.error ? 'alert' : 'status'} className={`notice ${notice.error ? 'error' : 'success'}`}>{notice.text}</div>}
          {extensionPath && <code data-testid="browser-extension-path" className="browser-endpoint">{extensionPath}</code>}
          <p className="browser-step-note">Chrome requires this one-time installation. The app cannot install the extension silently or read your Chrome profile directly.</p>
        </div>
      </li>
      <li>
        <span className={`browser-step-number ${connected ? 'complete' : ''}`}>{connected ? <Check size={13} /> : '3'}</span>
        <div className="browser-step-content">
          <div className="browser-step-heading"><h4>Connect the extension, then approve here</h4>{connected && <span className="browser-status online"><i />Paired</span>}</div>
          <p>Click <strong>Connect to app</strong> in the extension popup. Approve the matching request below to let that extension send website responses to this app.</p>
          {pending.length > 0 && <div className="browser-pairings" aria-live="polite">{pending.map(pairing => <div className="browser-pairing" key={pairing.id}>
            <div className="browser-pairing-details"><ShieldCheck size={16} /><div><strong>Extension requesting access</strong><code title={pairing.extensionId}>{pairing.extensionId.length > 24 ? `${pairing.extensionId.slice(0, 12)}…${pairing.extensionId.slice(-8)}` : pairing.extensionId}</code></div></div>
            <button data-testid={`browser-approve-${pairing.id}`} data-pairing-id={pairing.id} className="primary-btn" disabled={!!busy || !connector.running} onClick={() => task(`approve:${pairing.id}`, async () => { await call('browser:approve', { id: pairing.id }); setNotice({ text: 'Extension approved. Open a website below and sign in there if needed.' }); })}>{busy === `approve:${pairing.id}` ? <Loader2 size={14} className="spin" /> : <Link2 size={14} />}Approve connection</button>
          </div>)}</div>}
          {!connected && !pending.length && <div className="browser-awaiting"><Link2 size={14} />{connector.running ? 'Waiting for a connection request from the extension.' : 'Start the connector before connecting the extension.'}</div>}
          {pending.length > 0 && <p className="browser-step-note">Approve only a request you just started from your extension popup.</p>}
          {connector.paired && <div className="browser-step-actions"><button data-testid="browser-revoke" className="text-btn danger-text" disabled={!!busy} onClick={() => task('revoke', async () => { await call('browser:revoke'); setNotice({ text: 'Extension access revoked. Connect and approve it again to resume.' }); })}>{busy === 'revoke' ? <Loader2 size={14} className="spin" /> : <Unplug size={14} />}Revoke extension access</button></div>}
        </div>
      </li>
      <li>
        <span className="browser-step-number">4</span>
        <div className="browser-step-content">
          <h4>Open your websites</h4>
          <p>Use the Chrome profile with the extension installed. Sign in on each website if prompted, then select its model entry in your conversation.</p>
          <div className="browser-sites">{websites.map(website => {
            const site = connector.sites?.find(item => item.id === website.id);
            const detected = connected && !!site?.connected;
            const working = connected && !!site?.busy;
            const siteError = connected ? site?.error : undefined;
            const testResult = siteTests[website.id];
            const status = !connected ? 'Offline' : siteError ? 'Needs attention' : working ? 'Working' : detected ? 'Tab detected' : 'No tab detected';
            return <article className={`browser-site ${detected ? 'detected' : ''}`} key={website.id}>
              <div className="browser-site-heading"><span className={`browser-site-mark ${website.id}`}>{website.mark}</span><div><h5>{website.name}</h5><code>{website.model}</code></div></div>
              <span className={`browser-status ${working || detected ? 'online' : ''} ${siteError ? 'error' : ''}`} aria-live="polite">{working ? <Loader2 size={10} className="spin" /> : <i />}{status}</span>
              {siteError && <p className="browser-site-error" role="alert">{siteError}</p>}
              <button data-testid={`browser-site-${website.id}`} className="text-btn" disabled={!!busy} onClick={() => task(`site:${website.id}`, async () => { await call('browser:openSite', { siteId: website.id }); })}>{busy === `site:${website.id}` ? <Loader2 size={12} className="spin" /> : <ArrowUpRight size={12} />}Open {website.name}</button>
              <button data-testid={`browser-test-${website.id}`} className="text-btn" disabled={!!busy || !connected || !provider || working} onClick={() => task(`test:${website.id}`, async () => { setSiteTests(previous => ({ ...previous, [website.id]: undefined })); const result = await call<{ ok: boolean; message: string }>('provider:test', { id: provider!.id, model: website.model }); setSiteTests(previous => ({ ...previous, [website.id]: result })); })}>{busy === `test:${website.id}` ? <Loader2 size={12} className="spin" /> : <CheckCircle2 size={12} />}{busy === `test:${website.id}` ? 'Testing response…' : 'Test response'}</button>
              {testResult && <p data-testid={`browser-test-result-${website.id}`} role="status" className={`browser-site-test ${testResult.ok ? 'success' : 'error'}`}>{testResult.ok ? 'Last test passed. ' : 'Last test failed. '}{testResult.message}</p>}
            </article>;
          })}</div>
          <p className="browser-step-note">“Tab detected” means a chat input was found. Use Test response to check a completed reply; the test sends a short message that may appear in your website history. “Working” can include loading or waiting for a reply.</p>
          <p className="browser-step-note">These model entries choose a website. Use that website's model controls to select an available model.</p>
        </div>
      </li>
    </ol>
    {notice && notice.step !== 'install' && <div role="status" className={`notice ${notice.error ? 'error' : 'success'}`}>{notice.error ? <X size={16} /> : <CheckCircle2 size={16} />}<span>{notice.text}</span></div>}
  </div>;
}
