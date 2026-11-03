import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Hand, Loader2, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { PermissionMode, errorText } from './types';

const choices = [
  { value: 'ask', label: 'Ask for approval', description: 'Review every file change and shell command.', icon: Hand },
  { value: 'auto-edits', label: 'Approve file edits', description: 'Apply project file edits automatically. Ask before commands.', icon: ShieldCheck },
  { value: 'full', label: 'Full access', description: 'Apply file changes and run commands without asking.', icon: ShieldAlert },
] as const;

export default function PermissionsMenu({ value, disabled, planning, onChange }: { value: PermissionMode; disabled: boolean; planning: boolean; onChange(value: PermissionMode, confirmFullAccess?: boolean): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const current = choices.find(c => c.value === value) || choices[0];
  const closeMenu = (restore = false) => { setOpen(false); if (restore) triggerRef.current?.focus(); };
  const closeConfirm = () => { if (busy) return; setConfirm(false); triggerRef.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') || []);
    (items.find(item => item.getAttribute('aria-checked') === 'true') || items[0])?.focus();
    const outside = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) closeMenu(); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => { if (disabled && !busy) { setOpen(false); setConfirm(false); } }, [disabled, busy]);
  useEffect(() => { if (confirm) cancelRef.current?.focus(); }, [confirm]);
  const choose = async (next: PermissionMode, confirmed = false) => {
    if (disabled || busy) return;
    setError('');
    if (next === value) { closeMenu(true); return; }
    if (next === 'full' && !confirmed) { closeMenu(); setConfirm(true); return; }
    setBusy(true);
    try { await onChange(next, confirmed); setConfirm(false); closeMenu(true); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  return <div className="permissions-control" ref={rootRef}>
    <button ref={triggerRef} type="button" data-testid="permissions-trigger" className={`permissions-trigger ${value === 'full' ? 'full' : ''}`} aria-label={`Action permissions: ${current.label}`} aria-haspopup="menu" aria-expanded={open} aria-controls="action-permissions-menu" disabled={disabled || busy} title={disabled ? 'Stop the current agent before changing permissions' : 'Choose how agent actions are approved'} onClick={() => { setError(''); setOpen(v => !v); }} onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); } }}>
      {busy ? <Loader2 size={13} className="spin" /> : <current.icon size={13} />}<span>{current.label}</span><ChevronDown size={11} />
    </button>
    {open && <div id="action-permissions-menu" className="permissions-popover" role="menu" aria-label="How should agent actions be approved?" ref={menuRef} onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
      if (e.key === 'Tab') closeMenu(true);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') || []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }}>
      <div className="permissions-heading">How should agent actions be approved?</div>
      {choices.map(choice => <button key={choice.value} type="button" data-testid={`permission-${choice.value}`} aria-label={choice.label} className={`permission-option ${choice.value === 'full' ? 'full' : ''}`} role="menuitemradio" aria-checked={value === choice.value} tabIndex={-1} disabled={busy} onClick={() => void choose(choice.value)}><choice.icon size={17} /><span><strong>{choice.label}</strong><small>{choice.description}</small></span>{value === choice.value && <Check size={15} />}</button>)}
      <div className="permissions-scope">{planning && <strong>Plan mode stays read-only. </strong>}File tools stay within your selected project. Commands use your OS permissions and may access other files or the network. Model requests still go to your configured provider.</div>
      {error && <p className="permissions-error" role="alert">{error}</p>}
    </div>}
    {confirm && createPortal(<div className="modal-backdrop permissions-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) closeConfirm(); }}><section className="small-modal permissions-confirm" role="dialog" aria-modal="true" aria-labelledby="full-access-title" aria-describedby="full-access-description" ref={dialogRef} onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeConfirm(); }
      if (e.key === 'Tab') {
        const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}><div className="small-modal-heading"><h3 id="full-access-title"><ShieldAlert size={20} />Enable full access?</h3><button type="button" className="icon-btn" aria-label="Cancel full access" data-testid="full-access-close" onClick={closeConfirm} disabled={busy}><X size={17} /></button></div><p id="full-access-description">For this conversation, the agent can apply file changes and run shell commands without asking you first. Commands run with your OS permissions and can access files outside the project or use the network.</p><p>File tools remain scoped to the selected project. Plan mode still allows inspection only. New conversations start with Ask for approval.</p>{error && <p className="permissions-error" role="alert">{error}</p>}<div className="settings-actions"><button type="button" className="secondary-btn" data-testid="full-access-cancel" ref={cancelRef} disabled={busy} onClick={closeConfirm}>Keep current permissions</button><button type="button" className="primary-btn full-access-button" data-testid="full-access-confirm" disabled={busy} onClick={() => void choose('full', true)}>{busy && <Loader2 size={14} className="spin" />}Enable full access</button></div></section></div>, document.body)}
  </div>;
}
