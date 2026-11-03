import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const children = [];
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit', windowsHide: true }); children.push(vite);
let stopped = false;
const stop = () => { if (stopped) return; stopped = true; for (const child of children) child.kill(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('exit', stop);
vite.on('exit', code => { if (!stopped && code) { stop(); process.exitCode = code; } });
for (let attempt = 0; attempt < 100 && !stopped; attempt++) {
  try { if ((await fetch('http://127.0.0.1:5173', { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* Vite starting. */ }
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!stopped) {
  const env = { ...process.env, ANTIGRAVITY_DEV_URL: 'http://127.0.0.1:5173' }; delete env.ELECTRON_RUN_AS_NODE;
  const electron = spawn(require('electron'), ['.'], { stdio: 'inherit', env, windowsHide: true }); children.push(electron);
  electron.on('exit', code => { stop(); process.exitCode = code || 0; });
}
