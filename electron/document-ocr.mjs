import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DOCUMENT_LIMITS, documentError } from './document-limits.mjs';

const maximumOutputBytes = 512 * 1024;
const defaultRuntime = () => path.join(process.env.SystemRoot || (process.platform === 'win32' ? 'C:\\Windows' : path.parse(process.execPath).root), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// Native PDF rendering and OCR stay in one owned PowerShell process. No Office,
// downloaded OCR model, network request or user-supplied command is involved.
export class WindowsPdfOcr {
  constructor({ runtimePath = defaultRuntime(), scriptPath = new URL('./document-ocr.ps1', import.meta.url),
    timeoutMs = DOCUMENT_LIMITS.ocrTimeoutMs, platform = process.platform, spawnProcess = spawn } = {}) {
    if (!path.isAbsolute(runtimePath) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DOCUMENT_LIMITS.ocrTimeoutMs) throw new Error('Invalid local OCR configuration.');
    this.runtimePath = runtimePath; this.scriptPath = scriptPath instanceof URL ? fileURLToPath(scriptPath) : scriptPath;
    this.timeoutMs = timeoutMs; this.platform = platform; this.spawnProcess = spawnProcess; this.active = new Map();
  }
  cancelAll() { return Promise.all([...this.active.values()].map(cancel => cancel())); }
  extract(bytes, { signal } = {}) {
    if (this.platform !== 'win32') return Promise.reject(documentError('ocr_unavailable'));
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > DOCUMENT_LIMITS.bytes) return Promise.reject(documentError('too_large'));
    if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-')) return Promise.reject(documentError('malformed'));
    if (signal?.aborted) return Promise.reject(documentError('cancelled'));
    if (this.active.size >= 2) return Promise.reject(documentError('busy'));
    const controller = new AbortController(), job = Symbol('local PDF OCR');
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    let operation;
    // Reserve the slot before the first asynchronous filesystem operation.
    this.active.set(job, () => { controller.abort(); return operation?.catch(() => {}); });
    operation = (async () => {
      let directory;
      try {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gravity-local-ocr-'));
        if (controller.signal.aborted) throw documentError('cancelled');
        const input = path.join(directory, 'selected.pdf');
        await fs.writeFile(input, bytes, { flag: 'wx', mode: 0o600 });
        const script = await fs.readFile(this.scriptPath, 'utf8').catch(() => { throw documentError('ocr_unavailable'); });
        if (controller.signal.aborted) throw documentError('cancelled');
        const payload = await this.run(script, input, controller.signal);
        if (payload?.ok !== true) throw documentError(payload?.code);
        const result = payload.result;
        if (result?.format !== 'pdf' || result.ocr !== true || typeof result.content !== 'string' || !result.content.trim()
          || result.content.length > DOCUMENT_LIMITS.characters || !Number.isInteger(result.units) || result.units < 1 || result.units > DOCUMENT_LIMITS.ocrPages
          || typeof result.ocrLanguage !== 'string' || result.ocrLanguage.length > 40 || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(result.ocrLanguage)) throw documentError('ocr_failed');
        return { content: result.content.trim(), format: 'pdf', units: result.units, pages: result.units, ocr: true, ocrLanguage: result.ocrLanguage };
      } finally {
        signal?.removeEventListener('abort', abort);
        try {
          if (directory) {
            const resolved = path.resolve(directory);
            if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('gravity-local-ocr-')) throw new Error('Invalid OCR cleanup directory.');
            await fs.rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
          }
        } finally { this.active.delete(job); }
      }
    })();
    return operation;
  }
  run(script, input, signal) {
    return new Promise((resolve, reject) => {
      let child, failure, output = '', outputBytes = 0, exited = false;
      const cancel = () => { failure ||= documentError('cancelled'); if (!exited) child?.kill('SIGKILL'); };
      const timer = setTimeout(() => { failure ||= documentError('timeout'); if (!exited) child?.kill('SIGKILL'); }, this.timeoutMs);
      try {
        const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR'].filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
        // Windows can synthesize the inherited PATH when it is omitted. Give
        // this helper only the system directory, never developer/user tools.
        env.PATH = path.join(process.env.SystemRoot || (process.platform === 'win32' ? 'C:\\Windows' : path.parse(process.execPath).root), 'System32');
        env.GRAVITY_OCR_INPUT = input;
        child = this.spawnProcess(this.runtimePath, ['-NoProfile', '-NonInteractive', '-Command', script],
          { cwd: path.dirname(input), env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch { clearTimeout(timer); reject(documentError('ocr_unavailable')); return; }
      const finish = () => {
        exited = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
        if (failure) { reject(failure); return; }
        let payload; try { payload = JSON.parse(output.replace(/^\uFEFF/, '').trim()); } catch { reject(documentError('ocr_failed')); return; }
        resolve(payload);
      };
      signal.addEventListener('abort', cancel, { once: true });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > maximumOutputBytes) { failure ||= documentError('text_limit'); child.kill('SIGKILL'); return; }
        output += chunk;
      });
      child.on('error', () => { failure ||= documentError('ocr_unavailable'); });
      child.once('close', finish);
      if (signal.aborted) cancel();
    });
  }
}
