import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { UpdateError, UpdateService, UPDATE_REPOSITORY, isNewerRelease, releaseCandidate, releaseChecksum, verifyWindowsSignature } from '../electron/update-service.mjs';

const publisher = 'a'.repeat(64);
const binary = Buffer.from('Authored portable update fixture. No program is executed.');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const filename = 'Gravity-1.9.0-x64.exe';
const checksums = `${digest(binary)}  ${filename}\n`;
const base = `https://github.com/${UPDATE_REPOSITORY}/releases/download/v1.9.0/`;
function metadata(overrides = {}) {
  return { tag_name: 'v1.9.0', html_url: `https://github.com/${UPDATE_REPOSITORY}/releases/tag/v1.9.0`, draft: false, prerelease: false,
    assets: [
      { name: filename, state: 'uploaded', size: binary.length, browser_download_url: base + filename, digest: `sha256:${digest(binary)}` },
      { name: 'SHA256SUMS-1.9.0.txt', state: 'uploaded', size: Buffer.byteLength(checksums), browser_download_url: base + 'SHA256SUMS-1.9.0.txt' },
    ], ...overrides };
}
async function fixture(t, { policy = [publisher], release = metadata(), binaryBytes = binary, checksumText = checksums, fetchImpl, signatureVerifier } = {}) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'gravity-update-test-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir())); await fs.rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const policyPath = path.join(folder, 'policy.json');
  await fs.writeFile(policyPath, JSON.stringify({ repository: UPDATE_REPOSITORY, trustedSignerSha256: policy }));
  const downloadFolder = path.join(folder, 'downloads'); await fs.mkdir(downloadFolder);
  const requests = [], signatures = [], states = [];
  const service = new UpdateService({ version: '1.8.0', policyPath, onChange: state => states.push(state),
    signatureVerifier: signatureVerifier || (async (...args) => { signatures.push(args); return { certificateSha256: publisher }; }),
    fetchImpl: fetchImpl || (async (url, options) => {
      requests.push({ url, options });
      if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify(release));
      if (url.endsWith('.txt')) return new Response(checksumText);
      return new Response(binaryBytes);
    }),
  });
  return { folder, downloadFolder, policyPath, requests, signatures, states, service };
}

test('updates compare stable versions numerically and reject prerelease or malformed tags', () => {
  assert.equal(isNewerRelease('1.10.0', '1.9.9'), true);
  assert.equal(isNewerRelease('2.0.0', '1.99.99'), true);
  assert.equal(isNewerRelease('1.8.0', '1.8.0'), false);
  assert.equal(isNewerRelease('1.7.99', '1.8.0'), false);
  for (const version of ['v1.9.0', '1.9.0-beta', '01.9.0', '1.9', '-1.9.0', '9007199254740993.0.0']) assert.throws(() => isNewerRelease(version, '1.8.0'));
  assert.equal(releaseCandidate(metadata(), '1.9.0'), null);
});

test('release acceptance requires exact official versioned assets and no duplicates', () => {
  const candidate = releaseCandidate(metadata(), '1.8.0');
  assert.equal(candidate.version, '1.9.0'); assert.equal(candidate.executable.name, filename);
  for (const transform of [
    data => { data.draft = true; }, data => { data.prerelease = true; }, data => { data.html_url = 'https://github.com/other/Gravity/releases/tag/v1.9.0'; },
    data => { data.assets[0].browser_download_url = 'http://github.com/' + UPDATE_REPOSITORY + '/releases/download/v1.9.0/' + filename; },
    data => { data.assets[0].browser_download_url = base + filename + '?token=secret'; },
    data => { data.assets[0].browser_download_url = base.replace('github.com', 'github.com.evil.invalid') + filename; },
    data => { data.assets[0].browser_download_url = base.replace('v1.9.0', 'v1.8.0') + filename; },
    data => { data.assets[0].size = 401 * 1024 * 1024; }, data => { data.assets[0].digest = 'sha1:' + 'b'.repeat(40); },
    data => { data.assets.push(data.assets[0]); }, data => { data.assets.pop(); },
  ]) { const data = metadata(); transform(data); assert.throws(() => releaseCandidate(data, '1.8.0')); }
});

test('checksums require one exact filename, even when other release files are listed', () => {
  assert.equal(releaseChecksum(checksums + `${'b'.repeat(64)}  Gravity-1.9.0-source.zip\n`, filename), digest(binary));
  assert.equal(releaseChecksum(`${digest(binary)} *${filename}\r\n`, filename), digest(binary));
  for (const text of ['', checksums + checksums, checksums.replace(filename, '../' + filename), checksums.replace(filename, filename + '.old'), 'not a checksum']) assert.throws(() => releaseChecksum(text, filename));
});

test('update checks disclose only version/status and require configured signing before any download', async t => {
  const f = await fixture(t, { policy: [] });
  const state = await f.service.check();
  assert.equal(state.phase, 'available'); assert.equal(state.trustConfigured, false); assert.equal(state.availableVersion, '1.9.0');
  assert.equal(f.requests.length, 1); assert.ok(!JSON.stringify(state).includes(f.folder));
  assert.equal(f.requests[0].options.headers.Authorization, undefined); assert.equal(f.requests[0].options.redirect, 'manual');
  await assert.rejects(f.service.download(f.downloadFolder), { code: 'signing_not_configured' });
  assert.equal(f.requests.length, 1); assert.deepEqual(await fs.readdir(f.downloadFolder), []);
});

test('invalid or missing public signing policy disables downloads instead of trusting mutable state', async t => {
  for (const policy of [['not-a-hash'], Array(9).fill(publisher)]) {
    const f = await fixture(t, { policy }); assert.equal(f.service.status().trustConfigured, false);
  }
  const f = await fixture(t); await fs.writeFile(f.policyPath, '{malformed');
  assert.equal(new UpdateService({ version: '1.8.0', policyPath: f.policyPath }).status().trustConfigured, false);
});

test('GitHub no-release and rate limits produce useful states without accepting a download', async t => {
  const absent = await fixture(t, { fetchImpl: async () => new Response('Not found', { status: 404 }) });
  assert.equal((await absent.service.check()).phase, 'current'); assert.match(absent.service.status().message, /No published stable release/);
  await assert.rejects(absent.service.download(absent.downloadFolder), { code: 'no_update' });
  const limited = await fixture(t, { fetchImpl: async () => new Response('Private upstream body must not be displayed', { status: 429 }) });
  await assert.rejects(limited.service.check(), /limiting update checks/); assert.doesNotMatch(limited.service.status().message, /Private upstream/);
});

test('a verified download saves exactly the declared bytes and invokes signature verification without executing the file', async t => {
  const f = await fixture(t); await f.service.check();
  const ready = await f.service.download(f.downloadFolder);
  assert.equal(ready.phase, 'ready'); assert.equal(ready.filePath, path.join(f.downloadFolder, filename));
  assert.deepEqual(await fs.readFile(ready.filePath), binary); assert.equal(f.signatures.length, 1);
  assert.deepEqual(f.signatures[0][1], [publisher]); assert.ok(f.signatures[0][2].signal instanceof AbortSignal); assert.equal(f.signatures[0][2].expectedVersion, '1.9.0');
  assert.deepEqual(await fs.readdir(f.downloadFolder), [filename]); assert.equal(ready.receivedBytes, binary.length);
});

test('checksum tampering, oversized bodies and untrusted signatures never publish an executable', async t => {
  for (const options of [
    { binaryBytes: Buffer.from('Wrong bytes of a different size') },
    { binaryBytes: Buffer.alloc(binary.length + 1) },
    { checksumText: checksums.replace(digest(binary), 'b'.repeat(64)) },
    { signatureVerifier: async () => { throw new UpdateError('Unexpected certificate.', 'untrusted_signature'); } },
  ]) {
    const f = await fixture(t, options); await f.service.check(); await assert.rejects(f.service.download(f.downloadFolder));
    assert.deepEqual(await fs.readdir(f.downloadFolder), []); assert.equal(f.service.status().phase, 'error');
  }
});

test('update download cannot replace an existing file or write through a redirected directory', async t => {
  const f = await fixture(t); await f.service.check();
  await fs.writeFile(path.join(f.downloadFolder, filename), 'User-owned existing file');
  await assert.rejects(f.service.download(f.downloadFolder), { code: 'download_exists' });
  assert.equal(await fs.readFile(path.join(f.downloadFolder, filename), 'utf8'), 'User-owned existing file');
  assert.deepEqual(await fs.readdir(f.downloadFolder), [filename]);
  const alias = path.join(f.folder, 'redirect'); await fs.symlink(f.downloadFolder, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.download(alias), { code: 'invalid_directory' });
});

test('downloads reject unapproved redirect hosts, HTTPS downgrades and redirect loops', async t => {
  for (const location of ['http://github.com/' + UPDATE_REPOSITORY + '/release.exe', 'https://downloads.evil.invalid/update.exe', base + filename]) {
    const f = await fixture(t, { fetchImpl: async url => url.startsWith('https://api.github.com/') ? new Response(JSON.stringify(metadata()))
      : new Response('', { status: 302, headers: { location } }) });
    await f.service.check(); await assert.rejects(f.service.download(f.downloadFolder));
    assert.deepEqual(await fs.readdir(f.downloadFolder), []);
  }
});

test('an approved GitHub asset redirect still needs the same declared checksum and certificate', async t => {
  const redirected = 'https://release-assets.githubusercontent.com/github-production-release-asset/update-fixture';
  const f = await fixture(t, { fetchImpl: async url => {
    if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify(metadata()));
    if (url.endsWith('.txt')) return new Response(checksums);
    if (url === redirected) return new Response(binary);
    return new Response('', { status: 302, headers: { location: redirected } });
  } });
  await f.service.check(); assert.equal((await f.service.download(f.downloadFolder)).phase, 'ready'); assert.equal(f.signatures.length, 1);
});

test('update cancellation and deadlines terminate their owned requests', async t => {
  const f = await fixture(t, { fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  const pending = f.service.check();
  await assert.rejects(f.service.check(), { code: 'update_busy' });
  f.service.cancel(); await assert.rejects(pending, { code: 'cancelled' }); assert.equal(f.service.status().busy, false);
  const deadline = new UpdateService({ version: '1.8.0', checkTimeoutMs: 20, fetchImpl: f.service.fetchImpl });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(deadline.check(), { code: 'update_timeout' }); } finally { clearTimeout(keepAlive); }
  assert.equal(deadline.status().phase, 'error');
});

test('metadata is bounded and does not echo untrusted malformed content', async t => {
  const f = await fixture(t, { fetchImpl: async () => new Response('UNTRUSTED '.repeat(60000)) });
  await assert.rejects(f.service.check(), { code: 'download_too_large' }); assert.doesNotMatch(f.service.status().message, /UNTRUSTED/);
});

test('Windows signature verification requires Valid plus the pinned certificate and isolates its environment', async () => {
  const calls = [];
  const invoke = result => async (...args) => { calls.push(args); args.at(-1)(null, JSON.stringify(result)); };
  const target = "C:\\fixture folder\\quoted ' update.exe";
  const valid = await verifyWindowsSignature(target, [publisher], { platform: 'win32', execFileImpl: invoke({ status: 'Valid', certificateSha256: publisher }) });
  assert.equal(valid.certificateSha256, publisher);
  assert.equal(calls[0][2].windowsHide, true); assert.equal(calls[0][2].env.GRAVITY_UPDATE_FILE, target);
  assert.equal(calls[0][2].env.PATH, undefined); assert.equal(calls[0][2].env.HOME, undefined); assert.equal(calls[0][2].env.OPENAI_API_KEY, undefined);
  const command = Buffer.from(calls[0][1].at(-1), 'base64').toString('utf16le'); assert.ok(!command.includes(target)); assert.match(command, /Get-AuthenticodeSignature -LiteralPath \$env:GRAVITY_UPDATE_FILE/);
  for (const result of [{ status: 'NotSigned', certificateSha256: null }, { status: 'HashMismatch', certificateSha256: publisher }, { status: 'Valid', certificateSha256: 'b'.repeat(64) }])
    await assert.rejects(verifyWindowsSignature(target, [publisher], { platform: 'win32', execFileImpl: invoke(result) }), { code: 'untrusted_signature' });
  await assert.rejects(verifyWindowsSignature(target, [], { platform: 'win32', execFileImpl: invoke({}) }), { code: 'signing_not_configured' });
  for (const productVersion of ['1.9.0', '1.9.0.0']) assert.equal((await verifyWindowsSignature(target, [publisher], { platform: 'win32', expectedVersion: '1.9.0',
    execFileImpl: invoke({ status: 'Valid', certificateSha256: publisher, productVersion }) })).productVersion, productVersion);
  for (const productVersion of ['1.8.0', '1.8.0.0', '1.9.0-dev', undefined]) await assert.rejects(verifyWindowsSignature(target, [publisher], { platform: 'win32', expectedVersion: '1.9.0',
    execFileImpl: invoke({ status: 'Valid', certificateSha256: publisher, productVersion }) }), { code: 'version_mismatch' });
});

test('native Windows verifier cannot accept an executable signed by an unconfigured publisher', { skip: process.platform !== 'win32', timeout: 25000 }, async () => {
  await assert.rejects(verifyWindowsSignature(process.execPath, [publisher]), { code: 'untrusted_signature' });
});
