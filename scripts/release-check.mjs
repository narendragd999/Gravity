import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') throw new Error('The release gate must run on Windows x64.');
if (process.arch !== 'x64') throw new Error('The portable release gate requires an x64 runtime.');
const built = process.argv.includes('--built');
if (process.argv.slice(2).some(value => value !== '--built')) throw new Error('Usage: node scripts/release-check.mjs [--built]');
function gateEnvironment() {
  const environment = { ...process.env, GOTOOLCHAIN: 'local', ELECTRON_BUILDER_COMPRESSION_LEVEL: process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL || '3' };
  for (const key of ['WIN_CSC_LINK', 'CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'CSC_KEY_PASSWORD']) delete environment[key];
  return environment;
}
async function run(executable, args, label, cwd = root) {
  console.log(`Checking ${label}…`);
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: 'inherit', env: gateEnvironment() });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${label} failed (${code}).`)));
  });
}
const go = process.env.GRAVITY_GO_EXECUTABLE || 'go';
const goVersion = await new Promise((resolve, reject) => execFile(go, ['version'], { cwd: root, windowsHide: true, env: gateEnvironment(), maxBuffer: 8192 }, (error, output) => error ? reject(new Error('Go 1.26.5 is required. Install it or set GRAVITY_GO_EXECUTABLE to its executable.')) : resolve(output.trim())));
if (goVersion !== 'go version go1.26.5 windows/amd64') throw new Error(`Expected Go 1.26.5 for Windows x64; received ${goVersion}. Set GRAVITY_GO_EXECUTABLE to the matching toolchain.`);
await run(go, ['test', '-mod=readonly', './...'], 'Gemini bridge Go regressions', path.join(root, 'bridges', 'gemini-web2api'));
if (!built) await run(process.execPath, ['scripts/package-gemini.mjs'], 'optional Gemini bridge development build');
await run(process.execPath, ['--test', '--test-concurrency=2', 'tests/*.test.mjs'], 'source regressions');
if (!built) await run(process.execPath, ['scripts/package.mjs'], 'portable production build');
// Native smoke fixtures require this development companion runtime on a clean
// checkout. It is not required alongside the distributed portable executable.
await run(process.execPath, ['scripts/package-web2api.mjs'], 'native fixture runtime');
await run(process.execPath, ['node_modules/electron/cli.js', 'tests/electron-smoke.mjs'], 'native desktop acceptance');
await run(process.execPath, ['node_modules/electron/cli.js', 'tests/electron-browser-dom.mjs'], 'isolated website DOM acceptance');
await run(process.execPath, ['tests/portable-smoke.mjs'], 'relocated portable acceptance without developer runtimes');
await run(process.env.PYTHON || 'python', ['scripts/source-archive.py'], 'curated source archive');
await run(process.execPath, ['scripts/verify-package.mjs'], 'artifact inventory and checksums');
console.log('PASS: Windows release acceptance completed. Development artifacts remain unsigned unless built through release-build.mjs.');
