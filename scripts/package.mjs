import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { packageWeb2Api } from './package-web2api.mjs';
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
const sidecar = await packageWeb2Api({ outputDir: path.resolve('release', 'web2api-build') });
console.log(`Web2API companion: ${sidecar.outputDir} (${sidecar.files.length} files; private data excluded).`);
await run(['node_modules/electron-builder/cli.js', '--win', 'portable', '--x64', `-c.electronDist=${path.dirname(require('electron'))}`]);
