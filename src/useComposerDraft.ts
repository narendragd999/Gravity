import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { invoke, errorText } from './types';
import type { PickedFile, WorkspaceContext } from './types';
import { DraftPersistence } from './draftPersistence';

export type ComposerFile = PickedFile;
export type DraftFileMetadata = Omit<ComposerFile, 'id'>;
export interface ComposerDraft { prompt: string; images: string[]; files: ComposerFile[]; contexts: WorkspaceContext[]; missingFiles: DraftFileMetadata[] }
interface SavedDraft { prompt: string; images: string[]; files: DraftFileMetadata[]; contexts: WorkspaceContext[] }
const blank = (): ComposerDraft => ({ prompt: '', images: [], files: [], contexts: [], missingFiles: [] });
const metadata = ({ id: _id, ...file }: ComposerFile): DraftFileMetadata => file;
const persisted = (value: ComposerDraft): SavedDraft => ({ prompt: value.prompt, images: value.images, contexts: value.contexts,
  files: [...value.files.map(metadata), ...value.missingFiles] });
const restored = (value: SavedDraft | null): ComposerDraft => value ? { prompt: value.prompt || '', images: value.images || [],
  contexts: value.contexts || [], files: [], missingFiles: value.files || [] } : blank();

// Attachment IDs live only in this renderer's session cache. Disk snapshots
// contain metadata that requires a new picker selection after a restart.
export default function useComposerDraft(ownerKey: string, appReady: boolean, restoreSelection: (key: string) => void) {
  const [current, setCurrent] = useState<{ owner: string; value: ComposerDraft }>({ owner: ownerKey, value: blank() });
  const [initialized, setInitialized] = useState(!window.desktop);
  const [restoring, setRestoring] = useState(!!window.desktop);
  const [issue, setIssue] = useState('');
  const owner = useRef(ownerKey);
  const cache = useRef(new Map<string, ComposerDraft>());
  const live = useRef<{ owner: string; value: ComposerDraft } | undefined>(undefined);
  const generation = useRef(0), startup = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const restoreSelectionRef = useRef(restoreSelection); restoreSelectionRef.current = restoreSelection;
  const ready = appReady && initialized && !restoring && current.owner === ownerKey;
  const readyRef = useRef(ready); readyRef.current = ready;
  owner.current = ownerKey;
  if (ready) live.current = current;

  const remember = useCallback((key: string, value: ComposerDraft) => {
    cache.current.delete(key); cache.current.set(key, value);
    // Never evict unsaved content when encrypted storage reaches its limit.
    // The backend bounds persisted drafts; this session retains failed saves.
  }, []);
  const enqueue = useCallback((method: string, args: unknown, key: string) => {
    const operation = queue.current.catch(() => {}).then(() => invoke(method, args));
    queue.current = operation.catch(() => {});
    void operation.catch(error => { if (owner.current === key) setIssue(errorText(error)); });
    return operation;
  }, []);
  const persistenceRef = useRef<DraftPersistence<ComposerDraft> | undefined>(undefined);
  if (!persistenceRef.current) persistenceRef.current = new DraftPersistence<ComposerDraft>({
    save: (key, value) => window.desktop ? enqueue('draft:save', { key, value: persisted(value) }, key) : Promise.resolve(),
    clear: key => window.desktop ? enqueue('draft:clear', { key }, key) : Promise.resolve(),
    notice: setIssue,
  });
  const persistence = persistenceRef.current;
  const persistOwner = useCallback((key: string) => persistence.persist(key), [persistence]);
  const flush = useCallback(() => {
    clearTimeout(saveTimer.current);
    return persistence.flush();
  }, [persistence]);

  useEffect(() => {
    if (!appReady || startup.current || !window.desktop) return;
    startup.current = true;
    void invoke<{ key: string }>('draft:selected').then(({ key }) => restoreSelectionRef.current(key))
      .catch(error => setIssue(errorText(error))).finally(() => setInitialized(true));
  }, [appReady]);

  useEffect(() => {
    if (!appReady || !initialized) return;
    const nextGeneration = ++generation.current;
    clearTimeout(saveTimer.current);
    const previous = live.current;
    if (previous && previous.owner !== ownerKey) void persistOwner(previous.owner).catch(() => {});
    owner.current = ownerKey; setRestoring(true); setIssue(persistence.issue);
    const apply = (value: ComposerDraft) => {
      if (generation.current !== nextGeneration || owner.current !== ownerKey) return;
      remember(ownerKey, value); setCurrent({ owner: ownerKey, value }); setRestoring(false);
    };
    const cached = cache.current.get(ownerKey);
    if (cached || !window.desktop) apply(cached || blank());
    else void invoke<SavedDraft | null>('draft:get', { key: ownerKey }).then(value => apply(restored(value)))
      .catch(error => { if (generation.current === nextGeneration) { apply(blank()); setIssue(errorText(error)); } });
    if (window.desktop) void enqueue('draft:selected', { key: ownerKey }, ownerKey).catch(() => {});
    return () => { clearTimeout(saveTimer.current); };
  }, [ownerKey, appReady, initialized, enqueue, remember, persistOwner, persistence]);

  useEffect(() => {
    if (!ready) return;
    remember(ownerKey, current.value);
    saveTimer.current = setTimeout(() => { void persistOwner(ownerKey).catch(() => {}); }, 450);
    return () => clearTimeout(saveTimer.current);
  }, [ownerKey, ready, current, remember, persistOwner]);
  useEffect(() => {
    const beforeUnload = () => { void flush().catch(() => {}); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { window.removeEventListener('beforeunload', beforeUnload); clearTimeout(saveTimer.current); };
  }, [flush]);

  const setField = useCallback(<K extends keyof ComposerDraft>(field: K, value: SetStateAction<ComposerDraft[K]>) => {
    const previous = live.current;
    if (!readyRef.current || !previous || previous.owner !== owner.current) return;
    const next = typeof value === 'function' ? (value as (prior: ComposerDraft[K]) => ComposerDraft[K])(previous.value[field]) : value;
    live.current = { ...previous, value: { ...previous.value, [field]: next } };
    remember(previous.owner, live.current.value); persistence.update(previous.owner, live.current.value);
    setCurrent(live.current);
  }, [persistence, remember]);
  const setPrompt = useCallback<Dispatch<SetStateAction<string>>>(value => setField('prompt', value), [setField]);
  const setImages = useCallback<Dispatch<SetStateAction<string[]>>>(value => setField('images', value), [setField]);
  const setFiles = useCallback<Dispatch<SetStateAction<ComposerFile[]>>>(value => setField('files', value), [setField]);
  const setContexts = useCallback<Dispatch<SetStateAction<WorkspaceContext[]>>>(value => setField('contexts', value), [setField]);
  const setMissingFiles = useCallback<Dispatch<SetStateAction<DraftFileMetadata[]>>>(value => setField('missingFiles', value), [setField]);
  const snapshot = useCallback(() => live.current ? { ...live.current.value, images: [...live.current.value.images], files: [...live.current.value.files],
    contexts: [...live.current.value.contexts], missingFiles: [...live.current.value.missingFiles] } : blank(), []);
  const clearOwner = useCallback((key: string) => {
    if (live.current?.owner === key) clearTimeout(saveTimer.current);
    const value = blank(); remember(key, value);
    if (live.current?.owner === key && owner.current === key) { live.current = { owner: key, value }; setCurrent({ owner: key, value }); }
    return persistence.clear(key);
  }, [persistence, remember]);
  const stashOwner = useCallback((key: string, value: ComposerDraft, show = false) => {
    if (show && owner.current === key) { live.current = { owner: key, value }; setCurrent({ owner: key, value }); }
    remember(key, value); persistence.update(key, value);
    return persistence.persist(key);
  }, [persistence, remember]);
  const handoff = useCallback((previousKey: string, nextKey: string, value: ComposerDraft) => {
    remember(nextKey, value);
    void persistence.handoff(previousKey, nextKey, value).then(cleared => {
      if (!cleared) return;
      const empty = blank(); remember(previousKey, empty);
      if (live.current?.owner === previousKey && owner.current === previousKey) { live.current = { owner: previousKey, value: empty }; setCurrent(live.current); }
    }).catch(() => {});
  }, [persistence, remember]);
  const value = current.owner === ownerKey ? current.value : blank();
  return { ...value, setPrompt, setImages, setFiles, setContexts, setMissingFiles, ready, readyRef, issue, flush,
    snapshot, clearOwner, stashOwner, handoff, ownerRef: owner };
}
