import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
async function run(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true, env: { ...process.env, ELECTRON_BUILDER_COMPRESSION_LEVEL: process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL || '3' } });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Build step failed (${code}).`)));
  });
}
await run(['node_modules/typescript/bin/tsc', '--noEmit']);
await run(['node_modules/vite/bin/vite.js', 'build']);
await run(['scripts/collect-licenses.mjs']);
await run(['node_modules/electron-builder/cli.js', '--win', 'portable', '--x64', `-c.electronDist=${path.dirname(require('electron'))}`]);
