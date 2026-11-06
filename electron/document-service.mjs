import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCUMENT_EXTENSIONS, DOCUMENT_LIMITS, documentError } from './document-limits.mjs';
import { WindowsPdfOcr } from './document-ocr.mjs';
export { DOCUMENT_EXTENSIONS, DOCUMENT_LIMITS } from './document-limits.mjs';

// Each reader receives only authorized bytes in a separate process. Heap limits
// are not a total memory limit; process isolation protects the desktop if a
// parser fails, while input/expansion limits and a deadline bound ordinary work.
export class DocumentExtractor {
  constructor({ workerPath = new URL('./document-worker.mjs', import.meta.url),
    pdfWorkerPath = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href,
    timeoutMs = 15000, runtimePath = process.execPath, runtimeAsNode = !!process.versions.electron,
    ocrReader = new WindowsPdfOcr() } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid document reader timeout.');
    if (typeof runtimePath !== 'string' || !path.isAbsolute(runtimePath)) throw new Error('Invalid document reader runtime.');
    this.workerPath = workerPath instanceof URL ? fileURLToPath(workerPath) : workerPath;
    this.pdfWorkerPath = pdfWorkerPath; this.timeoutMs = timeoutMs; this.runtimePath = runtimePath;
    this.runtimeAsNode = runtimeAsNode; this.active = new Map(); this.ocr = ocrReader;
  }
  cancelAll() { return Promise.all([...this.active.values()].map(cancel => cancel()).concat(this.ocr.cancelAll())); }
  async extract(bytes, options, extra = {}) {
    const extension = typeof options === 'string' ? options : path.extname(options?.filename || '').toLowerCase();
    const signal = typeof options === 'string' ? extra.signal : options?.signal;
    if (!(bytes instanceof Uint8Array) || !DOCUMENT_EXTENSIONS.includes(extension)) throw documentError('unsupported');
    if (!bytes.byteLength || bytes.byteLength > DOCUMENT_LIMITS.bytes) throw documentError('too_large');
    if (signal?.aborted) throw documentError('cancelled');
    if (this.active.size + this.ocr.active.size >= 2) throw documentError('busy');
    if (typeof options === 'object' && options?.ocr !== undefined && typeof options.ocr !== 'boolean') throw documentError('unsupported');
    if (typeof options === 'object' && options?.ocr === true) {
      if (extension !== '.pdf') throw documentError('unsupported');
      return this.ocr.extract(bytes, { signal });
    }
    const data = Uint8Array.from(bytes);
    return new Promise((resolve, reject) => {
      let worker, timer, settled = false, exited = false, exitResolve;
      const exitPromise = new Promise(done => { exitResolve = done; });
      const finish = async (error, result) => {
        if (settled) return exitPromise; settled = true;
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        if (worker && !exited) {
          // The child owns no descendant tools or browser. Do not release its
          // slot or settle the operation before the operating system reaps it.
          try { worker.kill('SIGKILL'); } catch { /* exit/error still settles it */ }
          await exitPromise;
        }
        this.active.delete(worker);
        if (error) reject(error); else resolve(result);
      };
      const cancel = () => finish(documentError('cancelled'));
      try {
        const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR'].filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
        if (this.runtimeAsNode) env.ELECTRON_RUN_AS_NODE = '1';
        worker = fork(this.workerPath, [], { execPath: this.runtimePath, execArgv: ['--max-old-space-size=192'],
          cwd: path.dirname(this.workerPath), env, serialization: 'advanced', windowsHide: true,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      } catch { exited = true; exitResolve(); void finish(documentError('parser_unavailable')); return; }
      this.active.set(worker, cancel);
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => void finish(documentError('timeout')), this.timeoutMs);
      worker.on('message', message => {
        if (message?.ok !== true) { void finish(documentError(message?.code)); return; }
        const result = message.result;
        if (!result || typeof result.content !== 'string' || !result.content.trim() || result.content.length > DOCUMENT_LIMITS.characters
          || typeof result.format !== 'string' || !['pdf', 'docx', 'xlsx', 'pptx'].includes(result.format)
          || !Number.isInteger(result.units) || result.units < 1 || result.units > 2000) { void finish(documentError('parse_failed')); return; }
        void finish(null, { content: result.content, format: result.format, units: result.units,
          ...(result.format === 'pdf' ? { pages: result.units } : result.format === 'xlsx' ? { sheets: result.units } : result.format === 'pptx' ? { slides: result.units } : {}) });
      });
      worker.on('error', () => void finish(documentError('parser_unavailable')));
      worker.on('exit', () => { exited = true; exitResolve(); if (!settled) void finish(documentError('parse_failed')); });
      // A failed spawn may emit close without exit.
      worker.on('close', () => { exited = true; exitResolve(); });
      worker.send({ bytes: data, extension, pdfWorkerPath: this.pdfWorkerPath }, error => { if (error) void finish(documentError('parse_failed')); });
      if (signal?.aborted) void cancel();
    });
  }
}
