import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, CheckCircle2, Download, FolderOpen, Loader2, RefreshCw, ShieldCheck, Square } from 'lucide-react';
import { AppState, Invoke, UpdateState, errorText } from './types';
import './ConnectionPanels.css';

const signingGuide = 'https://github.com/narendragd999/Gravity/blob/main/docs/RELEASE-SIGNING.md';
function bytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return '0 B';
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${Math.round(value)} B`;
}

export default function UpdatesSettings({ state, call }: { state: AppState; call: Invoke }) {
  const [snapshot, setSnapshot] = useState<UpdateState | undefined>(state.updates);
  const [pending, setPending] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (state.updates) setSnapshot(state.updates); }, [state.updates]);
  const update = snapshot || state.updates;
  const busy = !!pending || !!update?.busy;
  const phase = update?.phase || 'idle';
  const currentVersion = update?.currentVersion || state.appVersion || '';
  const run = async (method: 'check' | 'download' | 'reveal') => {
    if (busy) return;
    setPending(method); setNotice(undefined);
    try {
      const result = await call<UpdateState | boolean>(`updates:${method}`);
      if (alive.current && result && typeof result === 'object') setSnapshot(result);
    } catch (error) {
      if (alive.current) { const text = errorText(error); setNotice({ text, error: !/cancelled|canceled/i.test(text) }); }
    } finally { if (alive.current) setPending(''); }
  };
  const cancel = async () => {
    setCancelling(true);
    try { const result = await call<UpdateState>('updates:cancel'); if (alive.current) setSnapshot(result); }
    catch (error) { if (alive.current) setNotice({ text: errorText(error), error: true }); }
    finally { if (alive.current) setCancelling(false); }
  };
  const openGuide = async () => {
    try { await call('shell:openExternal', { url: signingGuide }); }
    catch (error) { if (alive.current) setNotice({ text: errorText(error), error: true }); }
  };
  const total = typeof update?.totalBytes === 'number' && update.totalBytes > 0 ? update.totalBytes : 0;
  const received = typeof update?.receivedBytes === 'number' && update.receivedBytes > 0 ? update.receivedBytes : 0;
  const percent = total ? Math.min(100, Math.max(0, received / total * 100)) : undefined;
  const checkedAt = update?.checkedAt && Number.isFinite(Date.parse(update.checkedAt)) ? new Date(update.checkedAt).toLocaleString() : '';

  return <div className="updates-settings" data-testid="updates-settings">
    <div className="section-eyebrow">PORTABLE APP UPDATES</div><h2>Updates</h2>
    <p className="muted">Check for a newer release, then choose when to update Gravity.</p>
    <div className="update-current"><span>Current version</span><strong>{currentVersion || 'Available in the desktop app'}</strong></div>
    <section className={`update-status-card ${phase === 'ready' ? 'verified' : ''}`} aria-live="polite" aria-busy={busy}>
      <div className="update-status-heading">{busy ? <Loader2 size={20} className="spin" /> : phase === 'ready' ? <ShieldCheck size={20} /> : <RefreshCw size={20} />}
        <strong>{phase === 'checking' ? 'Checking for updates…' : phase === 'downloading' ? 'Downloading and verifying…' : phase === 'ready' ? 'Verified update ready' : phase === 'available' ? `Gravity ${update?.availableVersion} is available` : phase === 'current' ? 'Release check complete' : phase === 'error' ? 'Update needs attention' : 'Choose when to check'}</strong>
      </div>
      <p data-testid="update-status-message">{update?.message || 'Update checks are available from the desktop app.'}</p>
      {phase === 'downloading' && <div className="update-download-progress" data-testid="update-download-progress"><progress max={100} value={percent} aria-label="Update download progress" /><span>{bytes(received)}{total ? ` of ${bytes(total)}` : ''}</span></div>}
      {phase === 'ready' && update?.filePath && <p className="update-filename"><CheckCircle2 size={14} />{update.filePath.split(/[\\/]/).pop()}</p>}
      {checkedAt && <p className="update-checked"><time dateTime={update?.checkedAt}>Last checked: {checkedAt}</time></p>}
      <div className="settings-actions">
        <button className="secondary-btn" data-testid="updates-check" disabled={busy || !update} onClick={() => void run('check')}><RefreshCw size={14} />Check for updates</button>
        {phase === 'available' && <button className="primary-btn" data-testid="updates-download" disabled={busy || !update?.trustConfigured} onClick={() => void run('download')}><Download size={14} />Download verified update</button>}
        {phase === 'ready' && <button className="primary-btn" data-testid="updates-reveal" disabled={busy} onClick={() => void run('reveal')}><FolderOpen size={14} />Show downloaded file</button>}
        {busy && <button className="text-btn" data-testid="updates-cancel" disabled={cancelling} onClick={() => void cancel()}><Square size={13} />{cancelling ? 'Cancelling…' : 'Cancel'}</button>}
      </div>
    </section>
    {!update?.trustConfigured && <div className="update-signing-note" data-testid="updates-signing-required"><ShieldCheck size={18} /><div><strong>Release signing setup required</strong><p>This build has no trusted release certificate. Checking works; verified downloads require the owner's signing setup.</p><button className="text-btn" onClick={() => void openGuide()}>Open signing setup guide <ArrowUpRight size={13} /></button></div></div>}
    <p className="field-help">A downloaded update is checked against its release version, checksum and Windows publisher signature. Close Gravity when ready and open the verified file yourself.</p>
    {notice && <div className={`notice ${notice.error ? 'error' : 'success'}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</div>}
  </div>;
}
