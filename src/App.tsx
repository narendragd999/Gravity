import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, ArrowDown, ArrowRight, ArrowUp, ArrowUpRight, BookOpen, Check, CheckCircle2, ChevronDown, ChevronRight, Code2, Copy, Cpu, FileCode2, FolderOpen, GitBranch, History, Image as ImageIcon, Layers3, Loader2, Maximize2, MessageSquare, Minus, PanelLeftClose, PanelLeftOpen, PanelRight, Pencil, Plus, Radio, Search, Settings2, Sparkles, Square, Terminal, WandSparkles, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Settings, { SettingsPage } from './Settings';
import Workspace from './Workspace';
import PermissionsMenu from './PermissionsMenu';
import ChatConnection from './ChatConnection';
import { AgentMode, AppState, Conversation, Invoke, Message, PermissionMode, ProviderCapabilities, WorkspaceContext, errorText, initialState, invoke, modelLabel, supportsImages } from './types';

type PanelTab = 'files' | 'changes' | 'terminal' | 'artifacts';
export default function App() {
  const [state, setState] = useState<AppState>(initialState);
  const [selected, setSelected] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | undefined>();
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<AgentMode>('chat');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask');
  const [permissionSaving, setPermissionSaving] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [contexts, setContexts] = useState<WorkspaceContext[]>([]);
  const [capabilities, setCapabilities] = useState<{ key: string; value: ProviderCapabilities }>();
  const imagesAllowed = useRef(false);
  const createdForSend = useRef<string | undefined>(undefined);

  const addImageFiles = (files: FileList | File[]) => {
    if (!imagesAllowed.current) { setError('This connection does not accept images. Choose an image-capable API model to attach one.'); return; }
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = ev => {
          const result = ev.target?.result as string;
          if (result && result.startsWith('data:image/')) {
            setAttachments(prev => [...prev, result]);
          }
        };
        reader.readAsDataURL(file);
      }
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    if (e.defaultPrevented) return;
    const items = e.clipboardData?.items;
    if (!items || !items.length) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addImageFiles(files);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) {
      addImageFiles(e.dataTransfer.files);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  useEffect(() => {
    const onGlobalPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented) return;
      const activeEl = document.activeElement;
      if (activeEl && activeEl !== composerRef.current && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
        return;
      }
      const items = e.clipboardData?.items;
      if (!items || !items.length) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        addImageFiles(files);
        composerRef.current?.focus();
      }
    };
    window.addEventListener('paste', onGlobalPaste);
    return () => window.removeEventListener('paste', onGlobalPaste);
  }, []);
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(null);
  const [sidebar, setSidebar] = useState(true);
  const [workspace, setWorkspace] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>('files');
  const [artifact, setArtifact] = useState<{ name: string; content: string }>();
  const [reviewPath, setReviewPath] = useState<string>();
  const [reviewProjectId, setReviewProjectId] = useState<string>();
  const [reviewRequestId, setReviewRequestId] = useState(0);
  const [history, setHistory] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [rename, setRename] = useState<string | null>(null);
  const [renamedTitle, setRenamedTitle] = useState('');
  const [loading, setLoading] = useState(!!window.desktop);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messageEnd = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const [scrolledUp, setScrolledUp] = useState(false);
  const active = state.conversations.find(c => c.id === selected);
  const project = state.projects.find(p => p.id === (active?.projectId || projectId));
  const provider = state.providers.find(p => p.id === (active?.providerId || providerId));
  const hasConfiguredConnection = state.providers.some(p => p.managedBy === 'browser-connector' ? state.browserConnector.paired : p.hasApiKey) || state.bridges.some(b => b.state === 'ready') || state.bridge.running;
  const chosenModel = active?.model || model || provider?.defaultModel || '';
  const chosenMode = active?.mode || mode;
  const chosenPermission = active ? active.permissionMode || 'ask' : permissionMode;
  const capabilityKey = `${provider?.id || ''}:${chosenModel}`;
  const chosenCapabilities = capabilities?.key === capabilityKey ? capabilities.value : provider?.capabilities;
  const canAttachImages = capabilities?.key === capabilityKey ? capabilities.value.images : provider?.defaultModel === chosenModel && supportsImages(provider);
  imagesAllowed.current = canAttachImages;
  const running = active?.status === 'running';
  const activeRef = useRef(active); activeRef.current = active;
  const refresh = useCallback(async () => { const next = await invoke<AppState>('state:get'); setState(next); }, []);
  const call: Invoke = useCallback(async <T,>(method: string, args?: unknown) => { const result = await invoke<T>(method, args); if (/^(project:|conversation:|provider:save|provider:remove|provider:test|settings:|approval:|gateway:|bridge:|bridges:|browser:|web2api:|data:)/.test(method) && !['bridge:choose', 'bridges:choose'].includes(method)) await refresh(); return result; }, [refresh]);
  useEffect(() => {
    let cancelled = false;
    if (provider && window.desktop) void invoke<ProviderCapabilities>('provider:capabilities', { id: provider.id, model: chosenModel }).then(value => { if (!cancelled) setCapabilities({ key: capabilityKey, value }); }).catch(() => { /* The backend also checks capabilities before sending. */ });
    return () => { cancelled = true; };
  }, [capabilityKey]);
  useEffect(() => { setContexts(items => items.filter(item => item.projectId === project?.id)); }, [project?.id]);
  useEffect(() => { setReviewPath(undefined); setReviewProjectId(undefined); }, [project?.id]);
  useEffect(() => { if (!window.desktop) return; void refresh().catch(e => setError(errorText(e))).finally(() => setLoading(false)); return window.desktop.onEvent(event => {
    if (event.type === 'state') void refresh().catch(e => setError(errorText(e)));
    if (event.type === 'delta' && event.conversationId && event.messageId) setState(current => ({ ...current, conversations: current.conversations.map(c => c.id === event.conversationId ? { ...c, messages: c.messages.some(m => m.id === event.messageId) ? c.messages.map(m => m.id === event.messageId ? { ...m, content: event.content ?? m.content + (event.text || '') } : m) : [...c.messages, { id: event.messageId!, role: 'assistant', content: event.content ?? event.text ?? '', createdAt: new Date().toISOString() }] } : c) }));
  }); }, [refresh]);
  useEffect(() => { document.documentElement.dataset.theme = state.settings.theme; }, [state.settings.theme]);
  useEffect(() => { document.documentElement.style.setProperty('--ui-scale', String((state.settings.uiScale || 110) / 100)); }, [state.settings.uiScale]);
  useEffect(() => { if (!providerId || !state.providers.some(p => p.id === providerId)) { const latest = [...state.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).find(c => state.providers.some(p => p.id === c.providerId)); const preferred = state.providers.find(p => p.id === latest?.providerId) || state.providers.find(p => p.managedBy !== 'browser-connector' && p.hasApiKey) || state.providers.find(p => p.managedBy === 'browser-connector'); setProviderId(preferred?.id || ''); setModel(preferred?.defaultModel || ''); } }, [state.providers, state.conversations, providerId]);
  useEffect(() => { if (autoScroll.current) messageEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [active?.messages, active?.status]);
  useEffect(() => { autoScroll.current = true; setScrolledUp(false); if (selected !== createdForSend.current) { setPrompt(''); setAttachments([]); setContexts([]); } createdForSend.current = undefined; if (active) { setProjectId(active.projectId); setProviderId(active.providerId || ''); setModel(active.model); setMode(active.mode); setPermissionMode(active.permissionMode || 'ask'); } }, [selected]);
  const newConversation = useCallback(() => { createdForSend.current = undefined; setSelected(null); setHistory(false); setError(''); setPrompt(''); setAttachments([]); setContexts([]); setMode('chat'); setPermissionMode('ask'); setTimeout(() => composerRef.current?.focus(), 20); }, []);
  useEffect(() => { const handleKey = (e: KeyboardEvent) => { if (!(e.ctrlKey || e.metaKey)) return; if (e.key === 'n') { e.preventDefault(); newConversation(); } if (e.key === ',') { e.preventDefault(); setSettingsPage('setup'); } if (e.key === 'b') { e.preventDefault(); setSidebar(s => !s); } if (e.key === 'k') { e.preventDefault(); setHistory(h => !h); } }; window.addEventListener('keydown', handleKey); return () => window.removeEventListener('keydown', handleKey); }, [newConversation]);
  const doAction = async (fn: () => Promise<void>) => { setError(''); try { await fn(); } catch (e) { setError(errorText(e)); } };
  const addProject = () => doAction(async () => { const p = await call<{ id: string } | null>('project:add'); if (p) { setProjectId(p.id); setSelected(null); setPermissionMode('ask'); setHistory(false); setWorkspace(true); setPanelTab('files'); } });
  const selectConversation = (c: Conversation) => { setSelected(c.id); setHistory(false); setError(''); setAttachments([]); };
  const send = () => doAction(async () => {
    if ((!prompt.trim() && !attachments.length) || sending || running || permissionSaving) return;
    if (!provider) { setSettingsPage('setup'); throw new Error('Add a model provider to start a conversation.'); }
    if (!chosenModel) { setSettingsPage('providers'); throw new Error('Choose a model in provider settings first.'); }
    if (attachments.length && !canAttachImages) throw new Error('This model does not accept images. Remove the attachments or choose an image-capable API model.');
    setSending(true);
    const content = prompt.trim() || (attachments.length ? 'Please inspect the attached image.' : '');
    const images = [...attachments];
    const attachedContexts = [...contexts];
    try {
      let conversation = active;
      if (!conversation) {
        conversation = await call<Conversation>('conversation:create', { projectId, providerId: provider.id, model: chosenModel, mode: chosenMode, permissionMode: chosenPermission, confirmFullAccess: chosenPermission === 'full', title: content.slice(0, 68) });
        createdForSend.current = conversation.id;
        setSelected(conversation.id);
      }
      await call('conversation:send', { id: conversation.id, content, images, contexts: attachedContexts.map(({ projectId, path, startLine, endLine, revision }) => ({ projectId, path, startLine, endLine, revision })) });
      setPrompt('');
      setAttachments([]);
      setContexts([]);
      autoScroll.current = true;
    } catch (error) {
      setPrompt(content);
      setAttachments(images);
      setContexts(attachedContexts);
      throw error;
    } finally {
      setSending(false);
    }
  });
  const useProvider = async (id: string, name: string) => {
    if (running || sending) throw new Error('Stop the conversation before changing its model.');
    if (active) await call('conversation:update', { id: active.id, providerId: id, model: name });
    setProviderId(id); setModel(name); setError('');
  };
  const changeModel = (value: string) => doAction(async () => { const [id, name] = JSON.parse(value) as [string, string]; await useProvider(id, name); });
  const changeMode = (value: AgentMode) => doAction(async () => { if (active) await call('conversation:update', { id: active.id, mode: value }); setMode(value); });
  const attachContext = (context: WorkspaceContext) => {
    const next = [...contexts.filter(item => !(item.projectId === context.projectId && item.path === context.path && item.startLine === context.startLine && item.endLine === context.endLine)), context];
    if (next.length > 4 || next.reduce((sum, item) => sum + item.content.length, 0) > 60000) { setError('Attach up to four files or selections, with 60,000 characters in total. Remove a context or select fewer lines.'); return; }
    setContexts(next); setError(''); composerRef.current?.focus();
  };
  const changePermission = async (value: PermissionMode, confirmFullAccess = false) => {
    if (running || sending || permissionSaving) return;
    const targetId = active?.id;
    setPermissionSaving(true);
    try { if (targetId) await call('conversation:update', { id: targetId, permissionMode: value, confirmFullAccess }); if (activeRef.current?.id === targetId) setPermissionMode(value); }
    finally { setPermissionSaving(false); }
  };
  const renameConversation = (c: Conversation) => { setRename(c.id); setRenamedTitle(c.title); };
  const saveName = () => doAction(async () => { if (rename && renamedTitle.trim()) await call('conversation:update', { id: rename, title: renamedTitle.trim() }); setRename(null); });
  const visibleConversations = state.conversations.filter(c => !c.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const historyConversations = state.conversations.filter(c => !!c.archived === showArchived && (!historyQuery || `${c.title} ${state.projects.find(p => p.id === c.projectId)?.name || ''}`.toLowerCase().includes(historyQuery.toLowerCase()))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const runningCount = state.conversations.filter(c => c.status === 'running').length;
  const openArtifact = (artifact: { name: string; content: string }) => { setArtifact(artifact); setWorkspace(true); setPanelTab('artifacts'); };
  const reviewFile = (path: string) => { setReviewProjectId(project?.id); setReviewPath(path); setReviewRequestId(value => value + 1); setWorkspace(true); setPanelTab('changes'); };
  return <div className="app-shell">
    <div className="titlebar"><div className="titlebar-brand"><BrandMark /><span>Gravity</span></div><div className="titlebar-center">Desktop agent</div><div className="window-controls"><button title="Minimize" aria-label="Minimize window" onClick={() => doAction(async () => { await call('window:action', { action: 'minimize' }); })}><Minus size={14} /></button><button title="Maximize" aria-label="Maximize window" onClick={() => doAction(async () => { await call('window:action', { action: 'maximize' }); })}><Maximize2 size={12} /></button><button className="window-close" title="Close" aria-label="Close window" onClick={() => doAction(async () => { await call('window:action', { action: 'close' }); })}><X size={16} /></button></div></div>
    <div className="app-body">{sidebar && <aside className="sidebar"><div className="sidebar-heading"><span>Workspace</span><button className="icon-btn" title="Hide sidebar · Ctrl+B" onClick={() => setSidebar(false)}><PanelLeftClose size={16} /></button></div><button className={`new-conversation ${!selected && !history ? 'selected' : ''}`} onClick={newConversation}><Plus size={19} /><span>New conversation</span><kbd>Ctrl N</kbd></button><button className={`sidebar-nav ${history ? 'selected' : ''}`} onClick={() => setHistory(true)}><History size={17} /><span>Search chats</span><kbd>Ctrl K</kbd></button>
      <div className="sidebar-section-heading"><span>Projects</span><button className="icon-btn" title="Add project folder" onClick={addProject}><Plus size={15} /></button></div><div className="project-list">{state.projects.length ? state.projects.map(p => <div className="project-group" key={p.id}><button className={`project-button ${project?.id === p.id ? 'active' : ''}`} onClick={() => { setProjectId(p.id); setSelected(null); setPermissionMode('ask'); setHistory(false); }} title={p.path}><FolderOpen size={16} /><span>{p.name}</span><ChevronDown size={13} /></button>{visibleConversations.filter(c => c.projectId === p.id).slice(0, 4).map(c => <button className={`conversation-link ${selected === c.id ? 'active' : ''}`} key={c.id} onClick={() => selectConversation(c)} title={c.title}>{c.status === 'running' ? <span className="status-dot running" /> : <span className="conversation-branch" />}<span>{c.title}</span>{c.status === 'error' && <span className="error-dot" />}</button>)}</div>) : <button className="empty-project" onClick={addProject}><FolderOpen size={17} /><span>Open project</span></button>}</div>
      {visibleConversations.some(c => !c.projectId) && <><div className="sidebar-section-heading"><span>Recent conversations</span></div>{visibleConversations.filter(c => !c.projectId).slice(0, 7).map(c => <button className={`conversation-link standalone ${selected === c.id ? 'active' : ''}`} key={c.id} onClick={() => selectConversation(c)}>{c.status === 'running' ? <span className="status-dot running" /> : <MessageSquare size={14} />}<span>{c.title}</span></button>)}</>}
      <div className="sidebar-bottom">{runningCount > 0 && <div className="running-agents"><span className="status-dot running" /><span>{runningCount} agent{runningCount === 1 ? '' : 's'} working</span></div>}<button className="gateway-sidebar" onClick={() => setSettingsPage('setup')}><Cpu size={16} /><span>Connections</span></button><button className="sidebar-nav" onClick={() => setSettingsPage('setup')}><Settings2 size={17} /><span>Settings</span><kbd>Ctrl ,</kbd></button></div>
    </aside>}
    <main className="main-area"><header className="conversation-header"><div className="header-path">{!sidebar && <button className="icon-btn" onClick={() => setSidebar(true)} title="Show sidebar"><PanelLeftOpen size={17} /></button>}<FolderOpen size={15} /><span>{project?.name || 'Personal workspace'}</span><ChevronRight size={14} /><strong>{history ? 'Conversations' : active?.title || 'New conversation'}</strong>{active && <button className="icon-btn rename-button" title="Rename conversation" onClick={() => renameConversation(active)}><Pencil size={13} /></button>}</div><div className="header-actions">{running && <span className="working-badge"><span className="status-dot running" />Working</span>}<button className={`icon-btn ${workspace && panelTab === 'terminal' ? 'active' : ''}`} title="Open terminal" onClick={() => { setWorkspace(true); setPanelTab('terminal'); }}><Terminal size={17} /></button><button className={`icon-btn ${workspace ? 'active' : ''}`} title="Toggle workspace panel" onClick={() => setWorkspace(w => !w)}><PanelRight size={17} /></button></div></header>
      {!window.desktop && <div className="preview-banner"><MonitorIcon /><span>Interface preview · Open the desktop application to connect providers and work with local files.</span></div>}
      {history ? <section className="history-page"><div className="history-heading"><h1>Conversations</h1><button className="secondary-btn" onClick={newConversation}><Plus size={15} />New conversation</button></div><div className="history-filter"><div className="search-field"><Search size={16} /><input autoFocus placeholder="Search conversations or projects" value={historyQuery} onChange={e => setHistoryQuery(e.target.value)} /></div><button className={`secondary-btn ${showArchived ? 'selected' : ''}`} onClick={() => setShowArchived(!showArchived)}><Archive size={15} />{showArchived ? 'Archived' : 'Active'}</button></div><div className="history-list">{historyConversations.length ? historyConversations.map(c => <div className="history-row" key={c.id}><button onClick={() => selectConversation(c)}><div className="history-icon">{c.status === 'running' ? <Loader2 className="spin" size={19} /> : <MessageSquare size={19} />}</div><div><strong>{c.title}</strong><span>{state.projects.find(p => p.id === c.projectId)?.name || 'Personal workspace'} · {modelLabel(c.model) || 'No model'}</span></div><time>{relativeTime(c.updatedAt)}</time></button><button className="icon-btn" title="Rename" onClick={() => renameConversation(c)}><Pencil size={14} /></button><button className="icon-btn" disabled={c.status === 'running'} title={showArchived ? 'Restore conversation' : 'Archive conversation'} onClick={() => doAction(async () => { await call('conversation:update', { id: c.id, archived: !c.archived }); })}><Archive size={15} /></button></div>) : <div className="history-empty"><History size={35} /><h3>{historyQuery ? 'No matching conversations' : showArchived ? 'No archived conversations' : 'Your next idea starts here'}</h3><p>{historyQuery ? 'Try a different search.' : 'Conversations will appear here as you work.'}</p></div>}</div></section> : <>
      <div className={`conversation-scroll ${!active?.messages.length ? 'empty' : ''}`} ref={scrollRef} onScroll={() => { const el = scrollRef.current; if (el) { autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; setScrolledUp(!autoScroll.current); } }}>
        {loading ? <div className="welcome loading"><Loader2 size={25} className="spin" /><p>Opening your workspace…</p></div> : !active?.messages.length ? <section className="welcome"><div className="welcome-brand"><BrandMark /><span>Gravity</span></div><h1>{project ? `Let's work on ${project.name}` : 'Start a conversation'}</h1><p>{project ? 'Understand your code, plan a change, or build a feature.' : 'Ask a question, or open a project to work with your code.'}</p>{!hasConfiguredConnection && <div className="welcome-setup"><button className="primary-btn" data-testid="get-started" onClick={() => setSettingsPage('setup')}>Connect a model<ArrowRight size={16} /></button><span>Sign in once. Gravity prepares your connection.</span></div>}<div className="starter-grid"><button disabled={!!running || sending} onClick={() => { void changeMode('plan'); setPrompt('Explore this codebase and explain its architecture, key files, and how to run it.'); composerRef.current?.focus(); }}><Code2 size={16} /><strong>Explore project</strong><ArrowUpRight size={13} /></button><button disabled={!!running || sending} onClick={() => { void changeMode('build'); setPrompt('Help me plan and build a new feature. Start by reviewing the project and asking what I want to create.'); composerRef.current?.focus(); }}><WandSparkles size={16} /><strong>Build a feature</strong><ArrowUpRight size={13} /></button><button disabled={!!running || sending} onClick={() => { void changeMode('plan'); setPrompt('Review this project for bugs and suggest focused improvements. Explain your findings before making changes.'); composerRef.current?.focus(); }}><GitBranch size={16} /><strong>Review code</strong><ArrowUpRight size={13} /></button></div>
      </section> : <div className="message-list">{active.messages.map(message => <MessageView key={message.id} message={message} providerName={provider?.name || 'Agent'} call={call} onError={setError} openArtifact={openArtifact} onReviewFile={reviewFile} />)}{running && (!active.messages.length || active.messages[active.messages.length - 1]?.role !== 'assistant' || !active.messages[active.messages.length - 1]?.content) && <div className="thinking"><BrandMark /><span>Working on it</span><span className="thinking-dots"><i /><i /><i /></span></div>}<div ref={messageEnd} /></div>}
      </div>
      <div className="composer-area"><ChatConnection key={`${provider?.id}:${chosenModel}`} provider={provider} model={chosenModel} state={state} conversation={active} capabilities={chosenCapabilities} disabled={!!running || sending} call={call} onSettings={() => setSettingsPage('providers')} onBrowserSetup={() => setSettingsPage('browser')} onWebsiteSetup={() => setSettingsPage('setup')} onUseProvider={useProvider} /><RequestStatus conversation={active} />{scrolledUp && <button className="jump-latest" onClick={() => { autoScroll.current = true; messageEnd.current?.scrollIntoView({ behavior: 'smooth' }); }}><ArrowDown size={14} />Latest</button>}{error && <div className="composer-error" role="alert"><span>{error}</span><button className="icon-btn" onClick={() => setError('')} aria-label="Dismiss error"><X size={14} /></button></div>}<form className={`composer ${running ? 'is-working' : ''}`} onSubmit={e => { e.preventDefault(); void send(); }} onPaste={handlePaste} onDragOver={handleDragOver} onDrop={handleDrop}>
  {contexts.length > 0 && <div className="composer-contexts" data-testid="composer-contexts">{contexts.map((context, index) => <div className="composer-context-chip" key={`${context.projectId}:${context.path}:${context.startLine}:${context.endLine}`} title={`${context.path} · Saved lines ${context.startLine}–${context.endLine}`}><FileCode2 size={13} /><span>{context.label}<small>Lines {context.startLine}–{context.endLine} · saved file</small></span><button type="button" className="icon-btn" aria-label={`Remove ${context.label} context`} onClick={() => setContexts(items => items.filter((_, i) => i !== index))}><X size={12} /></button></div>)}</div>}
  {attachments.length > 0 && (
    <div className="composer-attachments">
      {attachments.map((img, index) => (
        <div key={index} className="attachment-chip">
          <img src={img} alt="Pasted attachment" className="attachment-thumb" />
          <button type="button" className="attachment-remove" onClick={() => setAttachments(prev => prev.filter((_, i) => i !== index))} title="Remove attachment" aria-label="Remove attachment"><X size={11} /></button>
        </div>
      ))}
    </div>
  )}
  <textarea ref={composerRef} aria-label="Message your agent" placeholder={running ? 'Your request is running…' : attachments.length ? 'Add a message or press Enter to send image…' : chosenMode === 'chat' ? 'Ask a question or talk through an idea…' : 'Describe what you want to plan or build…'} value={prompt} onChange={e => { setPrompt(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`; }} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!running) void send(); } }} onPaste={handlePaste} disabled={sending} rows={2} />
  <div className="composer-controls">
    <div className="composer-options">
      <button type="button" className="icon-btn add-context" onClick={() => { setWorkspace(true); setPanelTab('files'); }} title="Open project files"><Plus size={19} /></button>
      <label className={`icon-btn attachment-btn ${canAttachImages ? '' : 'unavailable'}`} title={canAttachImages ? 'Attach image (or paste with Ctrl+V)' : 'This connection does not accept images'}><ImageIcon size={17} /><input type="file" accept="image/*" multiple disabled={!canAttachImages || sending} style={{ display: 'none' }} onChange={e => { if (e.target.files) addImageFiles(e.target.files); e.target.value = ''; }} /></label>
      <div className="model-selector"><Cpu size={14} /><select aria-label="Model" value={provider ? JSON.stringify([provider.id, chosenModel]) : ''} onChange={e => changeModel(e.target.value)} disabled={running || sending || !state.providers.length}>{!provider && <option value="">Connect a model</option>}{state.providers.map(p => <optgroup label={p.name} key={p.id}>{[...new Set([...p.models, p.defaultModel, ...(p.id === provider?.id ? [chosenModel] : [])])].filter(Boolean).map(m => <option value={JSON.stringify([p.id, m])} key={m}>{modelLabel(m)}</option>)}</optgroup>)}</select><ChevronDown size={12} /></div><span className="composer-divider" /><div className="mode-selector"><select aria-label="Agent mode" value={chosenMode} onChange={e => changeMode(e.target.value as AgentMode)} disabled={running || sending}><option value="chat">Chat</option><option value="plan">Plan</option><option value="build">Build</option></select><ChevronDown size={12} /></div></div><div className="send-controls">{!provider && <button className="text-btn" type="button" onClick={() => setSettingsPage('setup')}>Set up<ArrowRight size={13} /></button>}{running ? <button type="button" className="send-btn stop-btn" aria-label="Stop agent" title="Stop agent" onClick={() => doAction(async () => { if (active) await call('conversation:stop', { id: active.id }); })}><Square size={15} fill="currentColor" /></button> : <button className="send-btn" aria-label="Send message" title="Send · Enter" disabled={(!prompt.trim() && !attachments.length) || sending || permissionSaving}>{sending ? <Loader2 size={17} className="spin" /> : <ArrowUp size={19} />}</button>}</div></div></form><div className="composer-permissions">{chosenMode === 'chat' ? <span className="permission-context" data-testid="chat-mode-note">Replies only · Attach files to discuss your code.</span> : <><PermissionsMenu key={selected || ('draft-' + (projectId || 'personal'))} value={chosenPermission} disabled={!!running || sending || permissionSaving} planning={chosenMode === 'plan'} onChange={changePermission} /><span className="permission-context">{chosenMode === 'plan' ? 'Plan mode: inspection only' : 'Applies to this conversation'}</span></>}<span className="composer-keyboard-hint">Enter to send · Shift Enter for a new line</span></div></div>
      </>}
    </main><div className="workspace-container" hidden={!workspace}><Workspace state={state} project={project} call={call} onClose={() => setWorkspace(false)} tab={panelTab} setTab={setPanelTab} artifact={artifact} setArtifact={setArtifact} onAttachContext={attachContext} reviewPath={reviewProjectId === project?.id ? reviewPath : undefined} reviewRequestId={reviewRequestId} /></div></div>
    <footer className="statusbar"><span><span className="status-dot online" />{runningCount ? `${runningCount} agent${runningCount === 1 ? '' : 's'} running` : 'Ready'}{project && <><span className="status-separator">/</span><FolderOpen size={11} />{project.name}</>}</span><span><button onClick={() => setSettingsPage('gateway')}>{state.gateway.running ? <Radio size={11} /> : <Cpu size={11} />}{state.gateway.running ? `API :${state.gateway.port}` : 'Local desktop'}</button></span></footer>
    {settingsPage && <Settings state={state} call={call} initialPage={settingsPage} activeProviderId={provider?.id} activeModel={chosenModel} modelSelectionDisabled={!!running || sending} onUseProvider={async (id, name) => { await useProvider(id, name); setSettingsPage(null); }} onClose={() => setSettingsPage(null)} />}
    {rename && <div className="modal-backdrop"><form className="small-modal" role="dialog" aria-label="Rename conversation" onSubmit={e => { e.preventDefault(); void saveName(); }}><div className="small-modal-heading"><h3>Rename conversation</h3><button type="button" className="icon-btn" onClick={() => setRename(null)} aria-label="Close"><X size={17} /></button></div><input autoFocus aria-label="Conversation title" value={renamedTitle} onChange={e => setRenamedTitle(e.target.value)} /><div className="settings-actions"><button className="secondary-btn" type="button" onClick={() => setRename(null)}>Cancel</button><button className="primary-btn" disabled={!renamedTitle.trim()}>Save name</button></div></form></div>}
  </div>;
}
function RequestStatus({ conversation }: { conversation?: Conversation }) {
  const [, tick] = useState(0);
  const request = conversation?.request;
  const running = conversation?.status === 'running';
  useEffect(() => { if (!running) return; const timer = window.setInterval(() => tick(value => value + 1), 1000); return () => window.clearInterval(timer); }, [running]);
  if (!request?.startedAt) return null;
  const started = Date.parse(request.startedAt);
  if (!Number.isFinite(started)) return null;
  const elapsed = request.elapsedMs ?? Math.max(0, (request.finishedAt ? Date.parse(request.finishedAt) : Date.now()) - started);
  const first = request.receivedAt ? Math.max(0, Date.parse(request.receivedAt) - started) : undefined;
  const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  if (!running) return <details className="request-progress request-timing" data-testid="request-progress"><summary>Last request: {request.phase} · {seconds(elapsed)}<ChevronDown size={11} /></summary><div role="status">{first !== undefined && <span>First response {seconds(first)} · </span>}<span>Total {seconds(elapsed)}</span></div></details>;
  return <div className="request-progress" data-testid="request-progress" role="status">{running && <Loader2 size={12} className="spin" />}<span>{request.phase}</span><time>{seconds(elapsed)} {running ? 'elapsed' : 'total'}</time>{first !== undefined && <small>First response {seconds(first)}</small>}</div>;
}
function MessageView({ message, providerName, call, onError, openArtifact, onReviewFile }: { message: Message; providerName: string; call: Invoke; onError(text: string): void; openArtifact(artifact: { name: string; content: string }): void; onReviewFile(path: string): void }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const approval = message.approval;
  const resolve = async (approved: boolean) => { if (!approval) return; setBusy(true); try { await call('approval:resolve', { id: approval.id, approved }); } catch (e) { onError(errorText(e)); } finally { setBusy(false); } };
  const copy = async () => { try { await call('clipboard:write', { text: message.content }); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch (e) { onError(errorText(e)); } };
  if (message.role === 'assistant' && !message.content.trim() && !approval && !message.artifact) return null;
  if (approval) return <article className={`approval-card ${approval.status}`}><div className="approval-heading"><div className="approval-icon">{approval.type === 'write' ? <FileCode2 size={19} /> : <Terminal size={19} />}</div><div><strong>{approval.autoApproved ? approval.type === 'write' ? 'File change' : 'Command' : approval.type === 'write' ? 'Review proposed file' : 'Review command'}</strong><span>{approval.type === 'write' ? approval.path : 'The agent would like to run this in your project'}</span></div><span className="approval-state">{approval.autoApproved ? 'Approved automatically' : approval.status === 'pending' ? 'Needs review' : approval.status}</span></div>{message.content && <p>{message.content}</p>}{approval.type === 'command' ? <pre className="command-preview">{approval.command}</pre> : <><button className="diff-toggle" onClick={() => setExpanded(!expanded)}><ChevronRight size={14} className={expanded ? 'rotate' : ''} />{expanded ? 'Hide' : 'View'} proposed content<span>{(approval.content || '').split('\n').length} lines</span></button>{expanded && <div className="approval-diff"><div><label>Current</label><pre>{approval.original || '(new file)'}</pre></div><div><label>Proposed</label><pre>{approval.content}</pre></div></div>}</>}{approval.status === 'pending' && <div className="approval-actions"><button className="secondary-btn" disabled={busy} onClick={() => resolve(false)}><X size={14} />Reject</button><button className="primary-btn" disabled={busy} onClick={() => resolve(true)}>{busy ? <Loader2 className="spin" size={14} /> : <Check size={14} />}{approval.type === 'write' ? 'Apply change' : 'Run command'}</button></div>}{approval.type === 'write' && approval.path && approval.status === 'approved' && <div className="approval-actions"><button className="secondary-btn" onClick={() => onReviewFile(approval.path!)}><GitBranch size={14} />Review changes</button></div>}</article>;
  if (message.artifact) return <button className="chat-artifact" onClick={() => openArtifact(message.artifact!)}><div><FileCode2 size={23} /></div><span><strong>{message.artifact.name}</strong><small>Artifact · Click to open</small></span><ArrowUpRight size={16} /></button>;
  if (message.role === 'tool') return <details className="tool-message"><summary><CheckCircle2 size={14} /><span>{toolLabel(message.toolName || 'Tool result')}</span><ChevronRight size={13} /></summary><pre>{message.content}</pre></details>;
  if (message.role === 'user') return (
    <article className="message user-message">
      <div className="user-message-text">
        {message.images && message.images.length > 0 && (
          <div className="user-message-attachments">
            {message.images.map((img, i) => (
              <img
                key={i}
                src={img}
                alt="Attachment"
                className="user-message-img"
                onClick={() => {
                  const w = window.open('');
                  if (w) {
                    w.document.write(`<title>Attachment</title><body style="margin:0;background:#0d1117;display:grid;place-items:center;min-height:100vh;"><img src="${img}" style="max-width:96vw;max-height:96vh;object-fit:contain;border-radius:6px;box-shadow:0 8px 30px rgba(0,0,0,0.5);"/></body>`);
                  }
                }}
                title="Click to view full image"
              />
            ))}
          </div>
        )}
        {message.content && <div>{message.content}</div>}
      </div>
    </article>
  );
  return <article className="message assistant-message"><div className="assistant-label"><BrandMark /><strong>{message.content.startsWith('Request failed:') ? 'Request failed' : providerName}</strong></div><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if (href) call('shell:openExternal', { url: href }).catch(e => onError(errorText(e))); }}>{children}</a> }}>{message.content || ' '}</ReactMarkdown></div><div className="message-actions"><button className="icon-btn" title={copied ? 'Copied' : 'Copy response'} onClick={copy}>{copied ? <Check size={13} /> : <Copy size={13} />}</button></div></article>;
}
function BrandMark() { return <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>; }
function MonitorIcon() { return <Code2 size={14} />; }
function toolLabel(name: string) { const labels: Record<string, string> = { read_file: 'Read file', list_files: 'Explore files', search_files: 'Search project', propose_file: 'Propose changes', run_command: 'Command result', create_artifact: 'Create artifact' }; return labels[name] || name.replaceAll('_', ' '); }
function relativeTime(value: string) { const date = new Date(value); if (Number.isNaN(date.valueOf())) return ''; const minutes = Math.floor((Date.now() - date.valueOf()) / 60000); if (minutes < 1) return 'Just now'; if (minutes < 60) return `${minutes}m ago`; if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`; return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
