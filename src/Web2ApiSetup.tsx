import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, CheckCircle2, Copy, Globe2, Loader2, Play, RefreshCw, Square, X } from 'lucide-react';
import { AppState, Invoke, errorText } from './types';

type WebsiteId = 'deepseek' | 'qwen' | 'chatgpt' | 'zai';
type SetupViewState = {
  available: boolean; busy: boolean; phase: string; message: string;
  sites: { id: WebsiteId; label: string; enabled: boolean }[];
  siteId?: WebsiteId; providerId?: string; bridgeId?: string;
  models?: string[]; defaultModel?: string; error?: string;
  stage?: string; errorCode?: string; recoveryAction?: string;
  browsers?: { channel: 'chrome' | 'msedge'; label: string; installed: boolean; version?: string }[];
  browserChannel?: 'chrome' | 'msedge';
};
const stageLabels: Record<string, string> = {
  'opening-browser': 'Opening your browser', 'waiting-for-sign-in': 'Waiting for your sign-in',
  'waiting-for-browser-close': 'Waiting for you to close that browser', 'releasing-profile': 'Saving the browser session',
  'opening-profile': 'Opening the saved session', navigating: 'Opening the website', 'checking-session': 'Checking website sign-in',
  'saving-session': 'Saving your connection', complete: 'Sign-in saved',
  'starting-service': 'Starting the website service', 'discovering-models': 'Checking available website connections',
  'waiting-idle': 'Session saved. Waiting for existing chats to finish before reloading the service',
  'restoring-service': 'Restoring the previous working connection',
};
const websites: { id: WebsiteId; label: string; mark: string }[] = [
  { id: 'zai', label: 'Z.ai', mark: 'Z' },
  { id: 'chatgpt', label: 'ChatGPT', mark: 'G' },
  { id: 'deepseek', label: 'DeepSeek', mark: 'D' },
  { id: 'qwen', label: 'Qwen', mark: 'Q' },
];

export default function Web2ApiSetup({ state, call, onUseProvider, modelSelectionDisabled }: {
  state: AppState; call: Invoke;
  onUseProvider?(providerId: string, model: string): Promise<void>;
  modelSelectionDisabled?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<SetupViewState>();
  const setup: SetupViewState | undefined = state.web2apiSetup || snapshot;
  const [siteId, setSiteId] = useState<WebsiteId>(() => state.web2apiSetup?.siteId || state.web2apiSetup?.sites.find(site => site.enabled)?.id || 'zai');
  const [checking, setChecking] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [command, setCommand] = useState('');
  const [notice, setNotice] = useState<string>();
  const [diagnostics, setDiagnostics] = useState('');
  const browserChoice = useRef<HTMLSelectElement>(null);
  const alive = useRef(true);
  const selectedByUser = useRef(false);
  const cancellationRequested = useRef(false);
  const refresh = async () => {
    setChecking(true); setNotice(undefined);
    try {
      const result = await call<SetupViewState>('web2api:refresh');
      if (alive.current && result) setSnapshot(result);
      const browsers = await call<SetupViewState>('web2api:browsers');
      if (alive.current && browsers?.available !== undefined) setSnapshot(browsers);
    } catch (error) { if (alive.current) setNotice(errorText(error)); }
    finally { if (alive.current) setChecking(false); }
  };
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (!selectedByUser.current && setup) setSiteId(setup.siteId || setup.sites.find(site => site.enabled)?.id || 'zai');
  }, [setup?.siteId, setup?.sites]);

  const modelWebsite = websites.find(website => setup?.defaultModel?.startsWith(`${website.id}-web`));
  const activeSite = setup?.siteId || (setup?.phase === 'ready' ? modelWebsite?.id : undefined) || siteId;
  const signingIn = setup?.phase === 'login' || setup?.phase === 'signing-in';
  const working = !!setup?.busy || connecting;
  const ready = setup?.phase === 'ready' && !!setup.providerId && !!setup.defaultModel;
  const checkedResponse = state.providers.find(provider => provider.id === setup?.providerId)?.lastTest;
  const responseCheck = checkedResponse?.model === setup?.defaultModel ? checkedResponse : undefined;
  const selectedWebsite = websites.find(site => site.id === siteId)!;
  const activeWebsite = websites.find(site => site.id === activeSite)!;
  const runCommand = async (label: string, method: string) => {
    setCommand(label); setNotice(undefined);
    if (label === 'cancel') cancellationRequested.current = true;
    try {
      const result = await call<SetupViewState>(method);
      if (alive.current && result) setSnapshot(result);
    } catch (error) { if (alive.current) setNotice(errorText(error)); }
    finally { if (alive.current) setCommand(''); }
  };
  const connect = async (forceLogin = false) => {
    selectedByUser.current = true;
    cancellationRequested.current = false;
    setConnecting(true); setNotice(undefined);
    try {
      const result = await call<SetupViewState>('web2api:connect', { siteId, ...(forceLogin ? { forceLogin: true } : {}) });
      if (alive.current && result) setSnapshot(result);
      if (alive.current && !cancellationRequested.current && result?.phase === 'ready' && result.providerId && result.defaultModel && onUseProvider && !modelSelectionDisabled) {
        await onUseProvider(result.providerId, result.defaultModel);
      }
    } catch (error) { if (alive.current && !cancellationRequested.current) setNotice(errorText(error)); }
    finally { if (alive.current) setConnecting(false); }
  };

  return <section className="web2api-setup" data-testid="web2api-setup" aria-label="Website connection setup">
    <div className="web2api-intro"><span className="web2api-intro-icon"><Globe2 size={24} /></span><div>
      <h3>Connect a website in one place</h3>
      <p>Choose a website and connect. Gravity saves the session, starts the service, and prepares your chat automatically.</p>
    </div></div>

    {checking && !setup && <p className="web2api-progress" role="status"><Loader2 size={15} className="spin" />Checking website setup…</p>}
    {setup?.available === false && !checking && <div className="web2api-missing" data-testid="web2api-missing">
      <strong>The website service is missing from this app</strong>
      <p>Reopen the complete Gravity release, then check again.</p>
      <button className="secondary-btn" disabled={checking || !!command} onClick={() => void refresh()}><RefreshCw size={14} />Check again</button>
    </div>}

    <div className="web2api-websites" aria-label="Choose a website">{websites.map(website => {
      const saved = !!setup?.sites.find(site => site.id === website.id)?.enabled;
      return <button key={website.id} data-testid={`web2api-site-${website.id}`} type="button" className={`web2api-website ${website.id} ${siteId === website.id ? 'selected' : ''}`}
        aria-pressed={siteId === website.id} disabled={working || checking || !!command}
        onClick={() => { selectedByUser.current = true; setSiteId(website.id); setNotice(undefined); }}>
        <span className={`browser-site-mark ${website.id}`}>{website.mark}</span>
        <span><strong>{website.label}</strong><small>{saved ? 'Saved session' : 'Sign in once'}</small></span>
        {siteId === website.id && <Check size={15} />}
      </button>;
    })}</div>

    {!!setup?.browsers?.length && <label className="field web2api-browser-choice">Browser for the next sign-in
      <select ref={browserChoice} data-testid="web2api-browser" value={setup.browserChannel || 'chrome'} disabled={working || checking || !!command} onChange={async event => {
        setCommand('browser'); setNotice(undefined);
        try { const result = await call<SetupViewState>('web2api:setBrowser', { channel: event.target.value }); if (alive.current && result) setSnapshot(result); }
        catch (error) { if (alive.current) setNotice(errorText(error)); }
        finally { if (alive.current) setCommand(''); }
      }}>{setup.browsers.map(browser => <option key={browser.channel} value={browser.channel} disabled={!browser.installed}>{browser.label}{browser.installed ? '' : ' · Not installed'}</option>)}</select>
      <small>Existing saved sessions keep their browser until you choose Sign in again.</small>
    </label>}

    <div className="web2api-main-actions">
      <button data-testid="web2api-connect" className="primary-btn" disabled={!setup?.available || working || checking || !!command} onClick={() => void connect()}>
        {working ? <Loader2 size={15} className="spin" /> : <Play size={15} />}{working ? 'Connecting…' : 'Connect & start'}
      </button>
      {!!setup?.sites.find(site => site.id === siteId)?.enabled && !working && <button data-testid="web2api-sign-in-again" className="secondary-btn" disabled={!setup?.available || checking || !!command} onClick={() => void connect(true)}>
        <Globe2 size={14} />Sign in again
      </button>}
      {!working && <span>Use {selectedWebsite.label}</span>}
      {working && <button data-testid="web2api-cancel" className="secondary-btn" disabled={command === 'cancel'} onClick={() => void runCommand('cancel', 'web2api:cancel')}>
        {command === 'cancel' ? <Loader2 size={14} className="spin" /> : <Square size={14} />}Cancel setup
      </button>}
    </div>

    {signingIn && <div className="web2api-login" data-testid="web2api-login" role="status">
      <div><Globe2 size={19} /><strong>Finish signing in to {activeWebsite.label}</strong></div>
      <p>Sign in in the browser that opened. Open a <strong>new, empty chat</strong>, then <strong>close that separate browser</strong>. Gravity continues automatically.</p>
      {setup?.stage && <p data-testid="web2api-stage" className="web2api-stage"><Loader2 size={13} className="spin" />{stageLabels[setup.stage] || setup.message}</p>}
      <p className="web2api-login-note">Complete any login or security checks requested by the website yourself.</p>
    </div>}

    {setup?.message && !signingIn && !ready && !setup.error && <p data-testid="web2api-progress" className="web2api-progress" role="status">
      {working && <Loader2 size={15} className="spin" />}{setup.stage && stageLabels[setup.stage] ? stageLabels[setup.stage] : setup.message}
    </p>}
    {ready && <div className="web2api-ready" data-testid="web2api-ready" role="status">
      <div><CheckCircle2 size={21} /><span><strong>{activeWebsite.label} service is ready</strong><small>Uses the model selected on the website</small></span></div>
      <p>{state.settings.bridgesAutoStart ? 'Starts automatically when Gravity opens.' : 'Automatic startup is off in advanced bridge settings.'} {responseCheck ? `Response ${responseCheck.ok ? 'verified' : 'test failed'} ${new Date(responseCheck.checkedAt).toLocaleString()}${responseCheck.durationMs !== undefined ? ` · ${(responseCheck.durationMs / 1000).toFixed(1)}s` : ''}.` : 'A response has not been tested by setup.'}</p>
      {onUseProvider && <button data-testid="web2api-use" className="primary-btn" disabled={working || !!command || !!modelSelectionDisabled} onClick={async () => {
        setCommand('use'); setNotice(undefined);
        try { await onUseProvider(setup.providerId!, setup.defaultModel!); }
        catch (error) { if (alive.current) setNotice(errorText(error)); }
        finally { if (alive.current) setCommand(''); }
      }}>{command === 'use' ? <Loader2 size={14} className="spin" /> : <ArrowUpRight size={14} />}Use in this chat</button>}
      {onUseProvider && modelSelectionDisabled && <p>Stop the running conversation to use this connection.</p>}
      <button data-testid="web2api-test-response" className="secondary-btn" disabled={working || !!command || !!modelSelectionDisabled} onClick={async () => {
        setCommand('test'); setNotice(undefined);
        try { const result = await call<{ ok: boolean; message: string }>('provider:test', { id: setup.providerId, model: setup.defaultModel }); if (!result.ok && alive.current) setNotice(result.message); }
        catch (error) { if (alive.current) setNotice(errorText(error)); }
        finally { if (alive.current) setCommand(''); }
      }}>{command === 'test' ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}Test response</button>
      <p className="web2api-login-note">Test response sends a short message. It may use account quota and appear in website chat history.</p>
    </div>}
    {(notice || setup?.error) && <div data-testid="web2api-error" className="notice error" role="alert"><X size={16} /><span>{notice || setup?.error}</span></div>}
    {setup?.error && <div className="web2api-recovery">
      {setup.recoveryAction === 'choose-browser' && <button data-testid="web2api-choose-browser" className="secondary-btn" disabled={working || !!command} onClick={() => { browserChoice.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); browserChoice.current?.focus(); }}><Globe2 size={14} />Choose another browser</button>}
      {setup.recoveryAction === 'open-account' && <button data-testid="web2api-open-account" className="secondary-btn" disabled={working || !!command} onClick={async () => {
        setCommand('account'); setNotice(undefined);
        try { await call('web2api:openAccount', { siteId: activeSite }); }
        catch (error) { if (alive.current) setNotice(errorText(error)); }
        finally { if (alive.current) setCommand(''); }
      }}><ArrowUpRight size={14} />Open website account</button>}
      {!working && setup.recoveryAction !== 'wait' && <button className="secondary-btn" disabled={!!command || checking || !setup.available} onClick={() => void connect(setup.recoveryAction === 'open-account')}><RefreshCw size={14} />Try connection again</button>}
    </div>}
    <details className="advanced web2api-diagnostics"><summary>Connection details & diagnostics</summary>
      {setup?.defaultModel && <p className="field-help">Connection model ID: <code>{setup.defaultModel}</code></p>}
      <button data-testid="web2api-copy-diagnostics" className="secondary-btn" disabled={!!command} onClick={async () => {
        setCommand('diagnostics'); setNotice(undefined);
        try { const result = await call<unknown>('web2api:diagnostics'); const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2); await call('clipboard:write', { text }); if (alive.current) setDiagnostics(text); }
        catch (error) { if (alive.current) setNotice(errorText(error)); }
        finally { if (alive.current) setCommand(''); }
      }}>{command === 'diagnostics' ? <Loader2 size={14} className="spin" /> : <Copy size={14} />}Copy diagnostics</button>
      {diagnostics && <><p className="field-help">Diagnostics copied. They exclude account credentials and chat content.</p><pre className="bridge-logs">{diagnostics}</pre></>}
    </details>
    <p className="web2api-footnote">Setup checks the connection without sending a chat message. Website account limits and available models still apply.</p>
  </section>;
}
