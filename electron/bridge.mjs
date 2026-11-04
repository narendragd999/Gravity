import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export class GeminiBridge {
  constructor({ directory, onChange = () => {}, onReady = () => {} }) {
    this.directory = directory; this.onChange = onChange; this.onReady = onReady;
    this.child = null; this.controller = null; this.starting = false; this.info = { running: false, port: 8081, logs: [] };
  }
  status() { return { ...this.info, starting: this.starting, logs: [...this.info.logs] }; }
  async start({ executable, config, port }) {
    if (this.child || this.starting) throw new Error('The managed bridge is already starting or running.');
    this.starting = true;
    delete this.info.error;
    this.controller = new AbortController();
    this.onChange();
    try { await this.launch({ executable, config, port }, this.controller); }
    catch (error) { this.info.error = error.message; if (!this.child) await fs.unlink(path.join(this.directory, 'bridge-runtime.json')).catch(() => {}); throw error; }
    finally { this.starting = false; this.onChange(); }
    return this.status();
  }
  async launch({ executable, config, port }, controller) {
    const signal = controller.signal;
    if (!path.isAbsolute(executable || '') || !(await fs.stat(executable)).isFile()) throw new Error('Choose the gemini-web2api executable first.');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid bridge port.');
    if (!path.isAbsolute(config || '')) throw new Error('Choose a gemini-web2api JSON configuration file.');
    // The user's original config and cookie remain untouched; only a private launch copy is adjusted.
    const original = JSON.parse(await fs.readFile(config, 'utf8'));
    const sourceDirectory = path.dirname(config);
    const cookie = path.resolve(sourceDirectory, original.cookie_file || 'cookie.txt');
    const token = randomBytes(32).toString('hex');
    const managed = { ...original, host: '127.0.0.1', port, api_keys: [token], log_requests: false, cookie_file: cookie };
    await new Promise((resolve, reject) => {
      const probe = net.createServer(); probe.once('error', () => reject(new Error(`Port ${port} is already in use. Choose a different bridge port or connect to the existing service.`))); probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });
    await fs.mkdir(this.directory, { recursive: true });
    const launchConfig = path.join(this.directory, 'bridge-runtime.json');
    await fs.writeFile(launchConfig, JSON.stringify(managed, null, 2), { mode: 0o600 });
    signal.throwIfAborted();
    const secrets = [token, ...(original.api_keys || []), original.xsrf_token].filter(Boolean);
    this.info = { running: false, port, logs: ['Starting bridge on loopback. Waiting for its health endpoint…'] };
    const child = spawn(executable, ['--config', launchConfig, '--port', String(port)], { cwd: sourceDirectory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    const log = chunk => {
      let text = String(chunk); for (const secret of secrets) text = text.split(secret).join('[redacted]');
      text = text.replace(/(__Secure-[\w-]+|Cookie|Authorization|XSRF)["'\s:=]+[^\r\n]+/gi, '$1: [redacted]');
      this.info.logs.push(text.slice(0, 1500)); this.info.logs = this.info.logs.slice(-60); this.onChange();
    };
    child.stdout.on('data', log); child.stderr.on('data', log);
    child.on('error', error => { this.info.error = error.message; controller.abort(); this.onChange(); });
    child.on('exit', code => { if (this.child === child) this.child = null; this.info.running = false; if (code && !signal.aborted) this.info.error = `Bridge exited with code ${code}.`; controller.abort(); this.onChange(); });
    this.onChange();
    const started = Date.now();
    while (this.child === child && !signal.aborted && Date.now() - started < 90000) {
      let ready = false;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]), redirect: 'error' });
        ready = response.ok && (await response.json()).status === 'ok';
      } catch { /* The upstream service initializes before listening. */ }
      if (ready && !signal.aborted && this.child === child) {
        try { await this.onReady({ port, token }); }
        catch (error) { await this.stop(); this.info.error = `Provider configuration failed: ${error.message}`; this.onChange(); throw new Error(this.info.error); }
        if (signal.aborted || this.child !== child) break;
        this.info.running = true; this.info.logs.push('Bridge is reachable. Model generation still depends on valid Gemini credentials.'); this.onChange(); return this.status();
      }
      await new Promise(resolve => {
        if (signal.aborted) { resolve(); return; }
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, 600); signal.addEventListener('abort', finish, { once: true });
      });
    }
    const error = this.info.error || (signal.aborted ? 'Bridge stopped before it became ready.' : 'Bridge startup exceeded 90 seconds. Check credentials and the bridge log.');
    await this.stop(); this.info.error = error; this.onChange(); throw new Error(error);
  }
  async stop() {
    this.controller?.abort();
    const child = this.child; this.child = null;
    if (child && child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); const timer = setTimeout(resolve, 3000); timer.unref(); });
    await fs.unlink(path.join(this.directory, 'bridge-runtime.json')).catch(() => {});
    this.info.running = false; this.onChange(); return this.status();
  }
}
