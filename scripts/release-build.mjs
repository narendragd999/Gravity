import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { packageWeb2Api } from './package-web2api.mjs';
import { packageDocuments } from './package-documents.mjs';
import { UPDATE_REPOSITORY, verifyWindowsSignature } from '../electron/update-service.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Signed release builds require Windows x64.');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version)) throw new Error('A stable package version is required.');
const arguments_ = process.argv.slice(2);
if (arguments_.length !== 2 || arguments_[0] !== '--tag' || arguments_[1] !== `v${pkg.version}`)
  throw new Error(`Usage: node scripts/release-build.mjs --tag v${pkg.version}`);
const certificate = process.env.WIN_CSC_LINK || process.env.CSC_LINK;
const certificatePassword = process.env.WIN_CSC_KEY_PASSWORD || process.env.CSC_KEY_PASSWORD;
const signerSha256 = process.env.GRAVITY_SIGNER_CERT_SHA256?.trim().toLowerCase();
if (!certificate || !certificatePassword || !/^[a-f0-9]{64}$/.test(signerSha256 || ''))
  throw new Error('Release signing is not configured. Set the certificate/password secrets and the public GRAVITY_SIGNER_CERT_SHA256 fingerprint as described in docs/RELEASE-SIGNING.md. No signed release was created.');
const signingEnvironment = { WIN_CSC_LINK: certificate, WIN_CSC_KEY_PASSWORD: certificatePassword };
for (const key of ['WIN_CSC_LINK', 'CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'CSC_KEY_PASSWORD']) delete process.env[key];
async function git(args) {
  return new Promise((resolve, reject) => execFile('git', args, { cwd: root, windowsHide: true, maxBuffer: 8192 }, (error, output) => error ? reject(new Error('The release tag could not be verified.')) : resolve(output.trim())));
}
const [head, tag, changes] = await Promise.all([git(['rev-parse', 'HEAD']), git(['rev-parse', '--verify', `refs/tags/${arguments_[1]}^{commit}`]), git(['status', '--porcelain'])]);
if (head !== tag) throw new Error('The release tag must resolve to the exact checked-out commit.');
if (changes) throw new Error('Commit or remove source changes before preparing a signed release candidate.');
async function run(args, signing = false) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: 'inherit', env: {
      ...process.env, ...(signing ? signingEnvironment : {}), ELECTRON_BUILDER_COMPRESSION_LEVEL: '3',
    } });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Release build step failed (${code}).`)));
  });
}
const policyFile = path.join(root, 'electron', 'release-policy.json');
await fs.writeFile(policyFile, JSON.stringify({ repository: UPDATE_REPOSITORY, trustedSignerSha256: [signerSha256] }, null, 2) + '\n');
// Only a public certificate fingerprint enters the app and source archive.
// Signing material stays in the environment accepted by electron-builder.
await run(['node_modules/typescript/bin/tsc', '--noEmit']);
await run(['node_modules/vite/bin/vite.js', 'build']);
await run(['scripts/collect-licenses.mjs']);
await packageWeb2Api({ sourceRoot: root, outputDir: path.join(root, 'release', 'web2api-build') });
await packageDocuments();
const config = { ...pkg.build, electronDist: path.dirname(require('electron')), forceCodeSigning: true,
  win: { ...pkg.build.win, signExecutable: true, signtoolOptions: { ...pkg.build.win.signtoolOptions, signingHashAlgorithms: ['sha256'] } } };
const configFile = path.join(root, 'release', `.release-builder-${process.pid}.json`);
await fs.writeFile(configFile, JSON.stringify(config), { flag: 'wx' });
try { await run(['node_modules/electron-builder/cli.js', '--config', configFile, '--win', 'portable', '--x64'], true); }
finally { await fs.unlink(configFile).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
for (const filename of [path.join(root, 'release', `Gravity-${pkg.version}-x64.exe`), path.join(root, 'release', 'win-unpacked', 'Gravity.exe')])
  await verifyWindowsSignature(filename, [signerSha256], { expectedVersion: pkg.version });
await run(['scripts/release-check.mjs', '--built']);
console.log(`PASS: Gravity ${pkg.version} signed candidate passed the Windows release gate. Inspect the candidate before publishing its draft release.`);
