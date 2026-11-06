import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The optional Gemini bridge build requires Windows x64.');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('A stable Gravity version is required.');
const go = process.env.GRAVITY_GO_EXECUTABLE || 'go';
const env = { ...process.env, GOTOOLCHAIN: 'local' };
const run = (executable, args, cwd = root) => new Promise((resolve, reject) => {
  execFile(executable, args, { cwd, env, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`Gemini bridge build failed: ${stderr || error.message}`)); else resolve(stdout.trim());
  });
});
if (await run(go, ['version']) !== 'go version go1.26.5 windows/amd64') throw new Error('Set GRAVITY_GO_EXECUTABLE to Go 1.26.5 for Windows x64.');
const release = path.join(root, 'release');
await fs.mkdir(release, { recursive: true });
const output = path.join(release, `Gravity-Gemini-Web2API-${pkg.version}-x64.exe`);
const version = `gravity-${pkg.version}`;
await run(go, ['build', '-mod=readonly', '-trimpath', '-ldflags', `-X main.Version=${version}`, '-o', output, '.'], path.join(root, 'bridges', 'gemini-web2api'));
if (await run(output, ['--version']) !== `gemini-web2api ${version}`) throw new Error('The built bridge has an unexpected version.');
console.log(`Built optional unsigned Gemini bridge: ${path.basename(output)}. Select it explicitly in Gravity; existing bridge installations are preserved.`);
