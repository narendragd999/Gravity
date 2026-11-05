import { ReactNode, useRef, useState } from 'react';
import { CheckCircle2, Chrome, Cpu, FolderOpen, Loader2, Play, Plus, RefreshCw, Save, Server, Square, Trash2, X } from 'lucide-react';
import { AppState, BridgeProfile, BridgeRuntime, Invoke, errorText } from './types';
import Web2ApiSetup from './Web2ApiSetup';

const BUILTIN_GEMINI = '__builtin_gemini';
type ProfileDraft = Omit<BridgeProfile, 'id' | 'args' | 'env'> & { id?: string; argsJson: string; envJson: string };
const blankProfile = (providerId = ''): ProfileDraft => ({ name: '', providerId, launchMode: 'external', executable: '', argsJson: '[]', cwd: '', envJson: '{}', healthUrl: '', startupTimeoutMs: 30000 });
const toDraft = (profile: BridgeProfile): ProfileDraft => ({ ...profile, argsJson: JSON.stringify(profile.args || [], null, 2), envJson: JSON.stringify(profile.env || {}, null, 2) });

export default function Bridges({ state, call, onAddProvider, onBrowserSetup, onUseProvider, modelSelectionDisabled, children }: { state: AppState; call: Invoke; onAddProvider(): void; onBrowserSetup(): void; onUseProvider?(providerId: string, model: string): Promise<void>; modelSelectionDisabled?: boolean; children: ReactNode }) {
  const [selected, setSelected] = useState<string | null>(state.bridgeProfiles[0]?.id || BUILTIN_GEMINI);
  const [draft, setDraft] = useState<ProfileDraft>(() => state.bridgeProfiles[0] ? toDraft(state.bridgeProfiles[0]) : blankProfile(state.providers.find(p => p.managedBy !== 'browser-connector')?.id));
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const actionSequence = useRef(0);
  const profiles = state.bridgeProfiles || [];
  const runtime = (state.bridges || []).find(bridge => bridge.id === draft.id);
  const provider = state.providers.find(item => item.id === draft.providerId);
  const managed = draft.launchMode === 'managed';
  const active = !!(runtime?.running || runtime?.starting);
  const fieldsDisabled = !!busy || active;

  const selectProfile = (profile?: BridgeProfile) => {
    setSelected(profile?.id || null);
    setDraft(profile ? toDraft(profile) : blankProfile(state.providers[0]?.id));
    setNotice(null);
    setRemoveConfirm(false);
  };
  const task = async (label: string, fn: (sequence: number) => Promise<void>) => {
    const sequence = ++actionSequence.current;
    setBusy(label);
    setNotice(null);
    try { await fn(sequence); } catch (error) { if (sequence === actionSequence.current) setNotice({ text: errorText(error), error: true }); }
    finally { if (sequence === actionSequence.current) setBusy(''); }
  };
  const saveDraft = async () => {
    if (!draft.name.trim()) throw new Error('Enter a bridge profile name.');
    if (!provider) throw new Error('Choose a saved model provider, or add one first.');
    let args: unknown;
    let env: unknown;
    try { args = JSON.parse(draft.argsJson || '[]'); } catch { throw new Error('Arguments must be a JSON array of strings, for example ["-m", "your_adapter"].'); }
    if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error('Arguments must be a JSON array of strings.');
    try { env = JSON.parse(draft.envJson || '{}'); } catch { throw new Error('Environment variables must be a JSON object with text values.'); }
    if (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some(value => typeof value !== 'string')) throw new Error('Environment variables must be a JSON object with text values.');
    if (!Number.isInteger(draft.startupTimeoutMs) || draft.startupTimeoutMs < 1000 || draft.startupTimeoutMs > 180000) throw new Error('Startup timeout must be a whole number between 1,000 and 180,000 milliseconds.');
    const saved = await call<BridgeProfile>('bridges:save', {
      id: draft.id, name: draft.name.trim(), providerId: draft.providerId, launchMode: draft.launchMode,
      executable: draft.executable.trim(), args, cwd: draft.cwd.trim(), env,
      healthUrl: draft.healthUrl?.trim() || '', startupTimeoutMs: draft.startupTimeoutMs,
    });
    setSelected(saved.id);
    setDraft(toDraft(saved));
    setRemoveConfirm(false);
    return saved;
  };
  const check = () => task('check', async sequence => {
    const saved = active && draft.id ? { id: draft.id } : await saveDraft();
    const result = await call<BridgeRuntime>('bridges:check', { id: saved.id });
    if (sequence === actionSequence.current) setNotice({ text: result.state === 'ready' ? 'Adapter is reachable. Select this provider and one of its models in your conversation.' : result.error || 'The adapter is not ready. See its status and logs below.', error: result.state !== 'ready' });
  });
  const choose = (kind: 'executable' | 'directory') => task('choose', async () => {
    const path = await call<string>('bridges:choose', { kind });
    if (path) setDraft(current => ({ ...current, [kind === 'executable' ? 'executable' : 'cwd']: path }));
  });
  const status = runtime?.state === 'ready' ? 'Adapter is ready' : runtime?.state === 'starting' ? 'Adapter is starting' : runtime?.state === 'error' ? 'Adapter needs attention' : managed ? 'Adapter is stopped' : 'Adapter is not connected';

  return <>
    <div className="section-eyebrow">WEB2API CONNECTIONS</div>
    <h2>Web2API Bridges</h2>
    <p className="muted">Connect a website below. Gravity manages its saved session and service.</p>
    <div data-testid="standalone-web2api-help"><Web2ApiSetup state={state} call={call} onBrowserSetup={onBrowserSetup} onUseProvider={onUseProvider} modelSelectionDisabled={modelSelectionDisabled} /></div>
    <button className="browser-provider-shortcut" onClick={onBrowserSetup}><Chrome size={20} /><span><strong>Browser Connector</strong><small>Use Claude, Gemini, or your usual Chrome tabs through the extension.</small></span></button>
    <details className="advanced bridge-expert-settings" data-testid="bridge-expert-settings"><summary>Advanced adapter profiles & configuration</summary><label className="check-label"><input type="checkbox" checked={state.settings.bridgesAutoStart} disabled={!!busy} onChange={e => { const bridgesAutoStart = e.target.checked; void task('settings', async () => { await call('settings:save', { bridgesAutoStart }); }); }} />Start saved bridge profiles when Gravity opens</label>
    <div className="provider-pills bridge-profile-pills">
      <button className={selected === BUILTIN_GEMINI ? 'active' : ''} disabled={!!busy} onClick={() => { setSelected(BUILTIN_GEMINI); setNotice(null); }}><Server size={14} />Gemini adapter</button>
      {profiles.map(profile => <button key={profile.id} className={selected === profile.id ? 'active' : ''} disabled={!!busy} onClick={() => selectProfile(profile)}><Server size={14} />{profile.name}</button>)}
      <button data-testid="bridge-profile-new" className={selected === null ? 'active' : ''} disabled={!!busy} onClick={() => selectProfile()}><Plus size={14} />Add bridge</button>
    </div>
    {selected === BUILTIN_GEMINI ? children : <>
      <div className="bridge-adapter-help">Use Managed to launch an installed adapter with Gravity, or External to connect to a server that is already running.</div>
      <div className="form-grid bridge-profile-grid">
        <label className="field">Bridge profile name<input id="bridge-profile-name" value={draft.name} disabled={fieldsDisabled} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} placeholder="My web adapter" /></label>
        <label className="field">Launch mode<select id="bridge-profile-mode" value={draft.launchMode} disabled={fieldsDisabled} onChange={event => setDraft(current => ({ ...current, launchMode: event.target.value as BridgeProfile['launchMode'] }))}><option value="external">External · already running</option><option value="managed">Managed · start from this app</option></select></label>
      </div>
      <div className="field-heading"><label htmlFor="bridge-profile-provider">Model provider</label><button className="text-btn" onClick={onAddProvider} disabled={!!busy}><Plus size={13} />Add provider</button></div>
      <select id="bridge-profile-provider" className="bridge-provider-select" value={draft.providerId} disabled={fieldsDisabled} onChange={event => setDraft(current => ({ ...current, providerId: event.target.value }))}>
        <option value="">Choose a provider</option>{state.providers.filter(item => item.managedBy !== 'browser-connector').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      {provider ? <p className="field-help"><Cpu size={13} /><span>{provider.baseUrl} · {provider.type === 'openai' ? 'OpenAI compatible' : provider.type === 'anthropic' ? 'Anthropic Messages' : 'Google Gemini'}</span></p> : <p className="field-help">Save a provider in Models & providers, then link it here.</p>}
      <p className="field-help">{managed ? 'Use a provider with a loopback base URL. Start launches the executable you configure below. The adapter must stay in the foreground; do not use a launcher that exits or detaches the server.' : 'Start your adapter separately, then use Check connection. This app will not launch an external adapter.'}</p>
      {managed && <>
        <label className="field" htmlFor="bridge-profile-executable">Executable</label>
        <div className="browse-input"><input id="bridge-profile-executable" value={draft.executable} disabled={fieldsDisabled} onChange={event => setDraft(current => ({ ...current, executable: event.target.value }))} placeholder="Absolute path to python.exe, node.exe, or an adapter executable" spellCheck={false} /><button className="secondary-btn" aria-label="Browse bridge executable" disabled={fieldsDisabled} onClick={() => choose('executable')}><FolderOpen size={15} />Browse</button></div>
        <details className="advanced"><summary>Launch arguments & environment</summary><label className="field">Arguments (JSON)<textarea id="bridge-profile-args" rows={3} className="bridge-json" value={draft.argsJson} disabled={fieldsDisabled} onChange={event => setDraft(current => ({ ...current, argsJson: event.target.value }))} placeholder={'["-m", "your_adapter"]'} spellCheck={false} /></label>
        <p className="field-help">Use the launch arguments documented by your installed adapter. Each argument is a separate JSON string. Arguments are stored as plain text; put credentials in encrypted environment variables or provider settings.</p>
        <label className="field" htmlFor="bridge-profile-directory">Working directory</label>
        <div className="browse-input"><input id="bridge-profile-directory" value={draft.cwd} disabled={fieldsDisabled} onChange={event => setDraft(current => ({ ...current, cwd: event.target.value }))} placeholder="Absolute path to the adapter folder" spellCheck={false} /><button className="secondary-btn" aria-label="Browse bridge working directory" disabled={fieldsDisabled} onClick={() => choose('directory')}><FolderOpen size={15} />Browse</button></div>
        <label className="field">Environment variables JSON<textarea id="bridge-profile-env" rows={3} className="bridge-json" value={draft.envJson} disabled={fieldsDisabled} onChange={event => setDraft(current => ({ ...current, envJson: event.target.value }))} placeholder={'{"ADAPTER_PORT": "8082"}'} spellCheck={false} autoComplete="off" /></label>
        <p className="field-help">Stored values are encrypted and displayed as ********. Keep a mask unchanged to retain its saved value; remove a key to delete it. Configure API credentials on the linked provider.</p></details>
      </>}
      <details className="advanced"><summary>Advanced connection checks</summary><label className="field">Health URL <span className="optional">Optional</span><input id="bridge-profile-health" value={draft.healthUrl || ''} disabled={fieldsDisabled} onChange={event => setDraft(current => ({ ...current, healthUrl: event.target.value }))} placeholder="Leave blank to check the provider API" spellCheck={false} /></label>
      <p className="field-help">A custom health URL must use the same origin as the provider base URL.</p>
      {managed && <label className="field inline-field">Startup timeout (milliseconds)<input id="bridge-profile-timeout" type="number" min={1000} max={180000} step={1000} value={draft.startupTimeoutMs} disabled={fieldsDisabled} onChange={event => setDraft(current => ({ ...current, startupTimeoutMs: Number(event.target.value) }))} /></label>}
      </details><div className={`connection-card ${runtime?.state === 'ready' ? 'online' : ''}`} aria-live="polite">
        <div>{runtime?.starting ? <Loader2 size={21} className="spin" /> : <Server size={21} />}<strong>{status}</strong></div>
        {provider && <code>{provider.baseUrl}</code>}
        <span>{managed ? 'Managed profile · Save never starts a process' : 'External adapter · Disconnect leaves its process running'}</span>
      </div>
      {active && <p className="field-help">Stop or disconnect this bridge before changing its configuration.</p>}
      <div className="settings-actions">
        <button data-testid="bridge-profile-save" className="secondary-btn" disabled={fieldsDisabled} onClick={() => task('save', async () => { await saveDraft(); setNotice({ text: 'Bridge profile saved. No process was started.' }); })}>{busy === 'save' ? <Loader2 size={14} className="spin" /> : <Save size={14} />}Save profile</button>
        {managed && <button data-testid="bridge-profile-start" className="primary-btn" disabled={!!busy || active} onClick={() => task('start', async sequence => { const saved = await saveDraft(); const result = await call<BridgeRuntime>('bridges:start', { id: saved.id }); if (sequence === actionSequence.current) setNotice({ text: result.state === 'ready' ? 'Adapter is ready. Select its provider and model in your conversation.' : result.error || 'Adapter startup is in progress. See status below.', error: result.state === 'error' }); })}>{busy === 'start' ? <Loader2 size={14} className="spin" /> : <Play size={14} />}Save & start bridge</button>}
        <button data-testid="bridge-profile-check" className={managed ? 'secondary-btn' : 'primary-btn'} disabled={!!busy || !!runtime?.starting} onClick={check}>{busy === 'check' ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}{!draft.id ? 'Save & check connection' : 'Check connection'}</button>
        {draft.id && <button data-testid="bridge-profile-stop" className="secondary-btn" disabled={(!!busy && busy !== 'start' && busy !== 'check') || !runtime || runtime.state === 'stopped'} onClick={() => task('stop', async () => { await call('bridges:stop', { id: draft.id }); setNotice({ text: managed ? 'Bridge stopped or disconnected. Processes started outside this app are left running.' : 'Disconnected. Any externally started adapter is left running.' }); })}><Square size={14} />{busy === 'check' ? 'Cancel check' : runtime?.starting ? 'Cancel startup' : managed ? 'Stop bridge' : 'Disconnect'}</button>}
        {draft.id && <button className="text-btn danger-text push-right" disabled={!!busy || active} onClick={() => { if (!removeConfirm) { setRemoveConfirm(true); return; } void task('remove', async () => { await call('bridges:remove', { id: draft.id }); selectProfile(); setNotice({ text: 'Bridge profile removed. Its model provider is unchanged.' }); }); }}><Trash2 size={14} />{removeConfirm ? 'Confirm removal' : 'Remove'}</button>}
      </div>
      {notice && <div role="status" className={`notice ${notice.error ? 'error' : 'success'}`}>{notice.error ? <X size={16} /> : <CheckCircle2 size={16} />}<span>{notice.text}</span></div>}
      {runtime?.error && <div className="notice error" role="alert">{runtime.error}</div>}
      <div className="setting-block"><h3>{managed ? 'Process output' : 'Connection log'}</h3><pre className="bridge-logs">{runtime?.logs?.length ? runtime.logs.join('\n') : managed ? 'No output yet. Start or check the bridge to see its status here.' : 'No checks yet. Check connection to see the adapter status.'}</pre></div>
    </>}
    </details>
  </>;
}
