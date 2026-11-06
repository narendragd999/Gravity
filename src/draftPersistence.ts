type PendingDraft<T> = { revision: number; action: 'save'; value: T } | { revision: number; action: 'clear' };
const saveFailure = 'Some drafts could not be saved. They are still kept in this session. Keep Gravity open and retry saving before closing.';

/** Serializes owner-specific saves without treating a failed write as saved. */
export class DraftPersistence<T> {
  readonly dirty = new Map<string, PendingDraft<T>>();
  private revisions = new Map<string, number>();
  private failures = new Set<string>();
  private sequence = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Set<Promise<unknown>>();
  private readonly storage: { save(key: string, value: T): Promise<unknown>; clear(key: string): Promise<unknown>; notice(message: string): void };
  constructor(storage: { save(key: string, value: T): Promise<unknown>; clear(key: string): Promise<unknown>; notice(message: string): void }) { this.storage = storage; }

  get issue() { return this.failures.size ? saveFailure : ''; }
  version(key: string) { return this.revisions.get(key) || 0; }
  update(key: string, value: T) {
    const revision = ++this.sequence;
    this.revisions.set(key, revision); this.dirty.set(key, { revision, action: 'save', value });
  }
  clear(key: string) {
    const revision = ++this.sequence;
    this.revisions.set(key, revision); this.dirty.set(key, { revision, action: 'clear' });
    return this.persist(key);
  }
  persist(key: string): Promise<unknown> {
    const token = this.dirty.get(key);
    if (!token) return Promise.resolve();
    const operation = this.queue.catch(() => {}).then(() => token.action === 'clear' ? this.storage.clear(key) : this.storage.save(key, token.value));
    this.queue = operation.catch(() => {}); this.pending.add(operation);
    void operation.then(() => {
      this.pending.delete(operation);
      if (this.dirty.get(key)?.revision === token.revision) {
        this.dirty.delete(key); this.failures.delete(key);
        this.storage.notice(this.failures.size ? saveFailure : '');
      }
    }, () => { this.pending.delete(operation); this.failures.add(key); this.storage.notice(saveFailure); });
    return operation;
  }
  async flush() {
    // A failed save belonging to an earlier chat remains dirty and is retried.
    await Promise.allSettled([...this.pending]);
    for (let round = 0; round < 8; round++) {
      const keys = [...this.dirty.keys()];
      if (!keys.length) return;
      const results = await Promise.allSettled(keys.map(key => this.persist(key)));
      if (results.some(result => result.status === 'rejected')) throw new Error(saveFailure);
      // A handoff or edit can create a newer write while the first batch saves.
      await Promise.allSettled([...this.pending]);
    }
    if (this.dirty.size) throw new Error('Drafts changed while saving. Keep Gravity open and try closing again.');
  }
  async handoff(source: string, destination: string, value: T) {
    if (source === destination) throw new Error('A draft needs a different destination.');
    const sourceVersion = this.version(source);
    this.update(destination, value);
    await this.persist(destination);
    // A new source draft is independent of the submitted snapshot.
    if (this.version(source) !== sourceVersion) return false;
    const cleared = this.clear(source), clearVersion = this.version(source);
    await cleared;
    return this.version(source) === clearVersion;
  }
}
