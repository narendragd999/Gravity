import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';

export const UPDATE_REPOSITORY = 'narendragd999/Gravity';
const API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
const DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const MAX_DOWNLOAD = 400 * 1024 * 1024;
const MAX_METADATA = 512 * 1024;
const MAX_CHECKSUMS = 64 * 1024;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const fingerprint = /^[a-fA-F0-9]{64}$/;

export class UpdateError extends Error {
  constructor(message, code = 'update_error') { super(message); this.name = 'UpdateError'; this.code = code; }
}

function versionParts(value) {
  if (typeof value !== 'string' || !stableVersion.test(value)) throw new UpdateError('Only stable release versions are supported.', 'invalid_release');
  const parts = value.split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) throw new UpdateError('The release version is invalid.', 'invalid_release');
  return parts;
}

export function isNewerRelease(candidate, current) {
  const left = versionParts(candidate), right = versionParts(current);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] > right[index];
  return false;
}

function httpsUrl(value, hosts) {
  let url;
  try { url = new URL(value); } catch { throw new UpdateError('The release contains an invalid download address.', 'invalid_release'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || !hosts.has(url.hostname))
    throw new UpdateError('The release download address is not an approved HTTPS host.', 'untrusted_download');
  return url;
}

export function releaseCandidate(data, currentVersion) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.draft !== false || data.prerelease !== false
    || typeof data.tag_name !== 'string' || !data.tag_name.startsWith('v')) throw new UpdateError('GitHub did not return a stable published release.', 'invalid_release');
  const version = data.tag_name.slice(1);
  versionParts(version);
  const releaseUrl = `https://github.com/${UPDATE_REPOSITORY}/releases/tag/v${version}`;
  if (data.html_url !== releaseUrl) throw new UpdateError('The release belongs to an unexpected repository.', 'invalid_release');
  if (!isNewerRelease(version, currentVersion)) return null;
  if (!Array.isArray(data.assets) || data.assets.length > 100) throw new UpdateError('The release asset list is invalid.', 'invalid_release');
  const find = (name, maximum) => {
    const entries = data.assets.filter(asset => asset?.name === name);
    if (entries.length !== 1) throw new UpdateError('This release does not contain one exact Windows portable executable and checksum file.', 'missing_release_asset');
    const asset = entries[0];
    if (asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > maximum)
      throw new UpdateError('The release asset exceeds the supported size or is not ready.', 'invalid_release');
    const url = httpsUrl(asset.browser_download_url, new Set(['github.com']));
    if (url.href !== `https://github.com/${UPDATE_REPOSITORY}/releases/download/v${version}/${name}`)
      throw new UpdateError('The release asset does not match its version and repository.', 'untrusted_download');
    let digest;
    if (asset.digest != null) {
      if (typeof asset.digest !== 'string' || !/^sha256:[a-fA-F0-9]{64}$/.test(asset.digest)) throw new UpdateError('The GitHub release digest is invalid.', 'invalid_release');
      digest = asset.digest.slice(7).toLowerCase();
    }
    return { name, size: asset.size, url: url.href, digest };
  };
  return { version, releaseUrl, executable: find(`Gravity-${version}-x64.exe`, MAX_DOWNLOAD), checksums: find(`SHA256SUMS-${version}.txt`, MAX_CHECKSUMS) };
}

export function releaseChecksum(source, filename) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_CHECKSUMS) throw new UpdateError('The release checksum file is invalid.', 'invalid_checksums');
  const entries = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)$/.exec(line);
    if (!match) throw new UpdateError('The release checksum file is malformed.', 'invalid_checksums');
    if (match[2] === filename) entries.push(match[1].toLowerCase());
  }
  if (entries.length !== 1) throw new UpdateError('The release checksum file does not identify one exact executable.', 'invalid_checksums');
  return entries[0];
}

function loadPolicy(policyPath) {
  try {
    const source = readFileSync(policyPath, 'utf8');
    if (source.length > 8192) return [];
    const data = JSON.parse(source);
    if (data.repository !== UPDATE_REPOSITORY || !Array.isArray(data.trustedSignerSha256) || data.trustedSignerSha256.length > 8
      || data.trustedSignerSha256.some(value => typeof value !== 'string' || !fingerprint.test(value))) return [];
    return [...new Set(data.trustedSignerSha256.map(value => value.toLowerCase()))];
  } catch { return []; }
}

async function safeDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new UpdateError('Choose an existing folder for the update.', 'invalid_directory');
  const absolute = path.resolve(directory), info = await fs.lstat(absolute);
  const real = await fs.realpath(absolute);
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (!info.isDirectory() || info.isSymbolicLink() || normalize(real) !== normalize(absolute))
    throw new UpdateError('Choose a regular folder without redirected paths.', 'invalid_directory');
  return absolute;
}

export async function verifyWindowsSignature(filename, trustedSignerSha256, { signal, expectedVersion, execFileImpl = execFile, platform = process.platform } = {}) {
  if (platform !== 'win32') throw new UpdateError('Verified portable updates require Windows.', 'unsupported_platform');
  if (!Array.isArray(trustedSignerSha256) || !trustedSignerSha256.length || trustedSignerSha256.some(value => !fingerprint.test(value)))
    throw new UpdateError('This build has no trusted signing certificate configured. Use the signing setup guide before enabling verified update downloads.', 'signing_not_configured');
  const script = `$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $env:GRAVITY_UPDATE_FILE
$certificateHash = $null
if ($signature.SignerCertificate) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $certificateHash = [BitConverter]::ToString($sha.ComputeHash($signature.SignerCertificate.RawData)).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
[PSCustomObject]@{ status = $signature.Status.ToString(); certificateSha256 = $certificateHash; productVersion = (Get-Item -LiteralPath $env:GRAVITY_UPDATE_FILE).VersionInfo.ProductVersion } | ConvertTo-Json -Compress`;
  const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
  env.GRAVITY_UPDATE_FILE = filename;
  let output;
  try {
    output = await new Promise((resolve, reject) => execFileImpl(executable,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env, windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024, signal }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  } catch {
    if (signal?.aborted) throw signal.reason;
    throw new UpdateError('Windows could not verify the downloaded executable signature.', 'signature_verification_failed');
  }
  let signature;
  try { signature = JSON.parse(output.trim()); } catch { throw new UpdateError('Windows returned an invalid signature result.', 'signature_verification_failed'); }
  if (signature.status !== 'Valid' || typeof signature.certificateSha256 !== 'string'
    || !trustedSignerSha256.map(value => value.toLowerCase()).includes(signature.certificateSha256.toLowerCase()))
    throw new UpdateError('The executable is unsigned, its signature is invalid, or it was signed by an unexpected certificate. No update was accepted.', 'untrusted_signature');
  if (expectedVersion !== undefined) {
    versionParts(expectedVersion);
    // Electron's main PE resource appends a fourth zero; the portable wrapper
    // uses the three-part version. Both resources are covered by Authenticode.
    if (![expectedVersion, expectedVersion + '.0'].includes(signature.productVersion))
      throw new UpdateError('The signed executable version does not match this release. No update was accepted.', 'version_mismatch');
  }
  return { certificateSha256: signature.certificateSha256.toLowerCase(), productVersion: signature.productVersion };
}

async function boundedBytes(response, maximum, signal) {
  if (!response.body) throw new UpdateError('GitHub returned an empty release file.', 'empty_download');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new UpdateError('The release file exceeded its size limit.', 'download_too_large');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export class UpdateService {
  constructor({ version, onChange = () => {}, policyPath = new URL('./release-policy.json', import.meta.url), fetchImpl = fetch,
    signatureVerifier = verifyWindowsSignature, checkTimeoutMs = 15000, downloadTimeoutMs = 180000 } = {}) {
    versionParts(version);
    if (!Number.isInteger(checkTimeoutMs) || checkTimeoutMs < 1 || checkTimeoutMs > 30000
      || !Number.isInteger(downloadTimeoutMs) || downloadTimeoutMs < 1 || downloadTimeoutMs > 600000) throw new UpdateError('Invalid update deadline.');
    this.version = version; this.onChange = onChange; this.fetchImpl = fetchImpl; this.signatureVerifier = signatureVerifier;
    this.checkTimeoutMs = checkTimeoutMs; this.downloadTimeoutMs = downloadTimeoutMs;
    this.trustedSigners = loadPolicy(policyPath);
    this.info = { phase: 'idle', busy: false, currentVersion: version, trustConfigured: !!this.trustedSigners.length,
      message: this.trustedSigners.length ? 'Check for a newer published release.' : 'Update checks are available. Verified downloads need a release signing certificate; see the signing setup guide.' };
  }
  status() { return { ...this.info }; }
  _change(values) { this.info = { ...this.info, ...values }; this.onChange(this.status()); }
  cancel() { this.active?.abort(new UpdateError('Update operation cancelled.', 'cancelled')); return this.status(); }
  async _run(timeoutMs, signal, operation) {
    if (this.active) throw new UpdateError('Wait for the current update operation or cancel it first.', 'update_busy');
    const controller = new AbortController(); this.active = controller;
    const cancel = () => controller.abort(new UpdateError('Update operation cancelled.', 'cancelled'));
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new UpdateError('The update operation timed out.', 'update_timeout')), timeoutMs);
    timer.unref?.();
    try { controller.signal.throwIfAborted(); return await operation(controller.signal); }
    catch (error) {
      const actual = controller.signal.aborted ? controller.signal.reason : error;
      const message = actual instanceof UpdateError ? actual.message : 'The update operation failed. Check your network and download folder, then try again.';
      this._change({ phase: actual?.code === 'cancelled' ? 'idle' : 'error', busy: false, message });
      throw actual instanceof UpdateError ? actual : new UpdateError(message);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); if (this.active === controller) this.active = undefined; }
  }
  async _fetch(urlValue, signal, api = false) {
    let url = httpsUrl(urlValue, api ? new Set(['api.github.com']) : DOWNLOAD_HOSTS);
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted();
      const response = await this.fetchImpl(url.href, { signal, redirect: 'manual', headers: {
        Accept: api ? 'application/vnd.github+json' : 'application/octet-stream', 'User-Agent': 'Gravity-Desktop-Updater',
        ...(api ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}),
      } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel().catch(() => {});
        if (!location || redirects === 3) throw new UpdateError('The release download redirected too many times.', 'invalid_redirect');
        url = httpsUrl(new URL(location, url).href, api ? new Set(['api.github.com']) : DOWNLOAD_HOSTS); continue;
      }
      if (api && response.status === 404) { await response.body?.cancel().catch(() => {}); return null; }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new UpdateError(response.status === 403 || response.status === 429
        ? 'GitHub is limiting update checks. Try again later.' : 'GitHub could not provide this release file.', 'release_unavailable'); }
      return response;
    }
  }
  check({ signal } = {}) {
    return this._run(this.checkTimeoutMs, signal, async ownedSignal => {
      this._change({ phase: 'checking', busy: true, message: 'Checking the official Gravity releases…', filePath: undefined, receivedBytes: undefined, totalBytes: undefined });
      const response = await this._fetch(API_URL, ownedSignal, true);
      let candidate;
      if (response) {
        const bytes = await boundedBytes(response, MAX_METADATA, ownedSignal);
        let data; try { data = JSON.parse(bytes.toString('utf8')); } catch { throw new UpdateError('GitHub returned invalid release metadata.', 'invalid_release'); }
        candidate = releaseCandidate(data, this.version);
      }
      this.latest = candidate;
      this._change({ phase: candidate ? 'available' : 'current', busy: false, availableVersion: candidate?.version,
        releaseUrl: candidate?.releaseUrl, checkedAt: new Date().toISOString(), message: candidate
          ? `Gravity ${candidate.version} is available.${this.trustedSigners.length ? ' Download and verify it when ready.' : ' This build has no trusted signing certificate; verified downloads are unavailable until signing is configured.'}`
          : response ? 'You have the latest published stable release.' : 'No published stable release is available yet.' });
      return this.status();
    });
  }
  async download(directory, { signal } = {}) {
    if (!this.latest) throw new UpdateError('Check for a newer release before downloading.', 'no_update');
    if (!this.trustedSigners.length) throw new UpdateError('This build has no trusted signing certificate configured. Prepare release signing first; no executable was downloaded.', 'signing_not_configured');
    const destination = await safeDirectory(directory), candidate = this.latest;
    return this._run(this.downloadTimeoutMs, signal, async ownedSignal => {
      this._change({ phase: 'downloading', busy: true, filePath: undefined, receivedBytes: 0, totalBytes: candidate.executable.size, message: 'Downloading and verifying the signed portable update…' });
      const checksumResponse = await this._fetch(candidate.checksums.url, ownedSignal);
      const checksumBytes = await boundedBytes(checksumResponse, MAX_CHECKSUMS, ownedSignal);
      if (checksumBytes.length !== candidate.checksums.size || candidate.checksums.digest && createHash('sha256').update(checksumBytes).digest('hex') !== candidate.checksums.digest)
        throw new UpdateError('The checksum file does not match its release metadata.', 'checksum_mismatch');
      const expected = releaseChecksum(checksumBytes.toString('utf8'), candidate.executable.name);
      if (candidate.executable.digest && candidate.executable.digest !== expected) throw new UpdateError('The release checksum and GitHub digest disagree.', 'checksum_mismatch');
      const temporary = path.join(destination, `.gravity-update-${randomUUID()}.part`), target = path.join(destination, candidate.executable.name);
      let handle, reader; let created = false;
      try {
        handle = await fs.open(temporary, 'wx', 0o600); created = true;
        const response = await this._fetch(candidate.executable.url, ownedSignal);
        if (!response.body) throw new UpdateError('GitHub returned an empty executable.', 'empty_download');
        reader = response.body.getReader(); const hash = createHash('sha256'); let size = 0, lastProgress = 0;
        while (true) {
          ownedSignal.throwIfAborted();
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > candidate.executable.size || size > MAX_DOWNLOAD) throw new UpdateError('The executable exceeded its declared size.', 'download_too_large');
          hash.update(value); await handle.writeFile(value);
          if (Date.now() - lastProgress >= 250) { lastProgress = Date.now(); this._change({ receivedBytes: size }); }
        }
        if (size !== candidate.executable.size || hash.digest('hex') !== expected) throw new UpdateError('The executable checksum did not match. No update was accepted.', 'checksum_mismatch');
        await handle.sync(); await handle.close(); handle = undefined;
        await this.signatureVerifier(temporary, this.trustedSigners, { signal: ownedSignal, expectedVersion: candidate.version });
        ownedSignal.throwIfAborted();
        await safeDirectory(destination);
        // A hard link atomically publishes the verified bytes without replacing
        // an existing file. The desktop never executes or installs this file.
        try { await fs.link(temporary, target); }
        catch (error) { if (error.code === 'EEXIST') throw new UpdateError('An update with this filename already exists. Choose another folder.', 'download_exists'); throw error; }
        this._change({ phase: 'ready', busy: false, receivedBytes: size, filePath: target,
          message: 'The update passed SHA-256 and Windows signature verification. Close Gravity when ready and open the downloaded executable yourself.' });
        return this.status();
      } finally {
        await reader?.cancel().catch(() => {}); reader?.releaseLock(); await handle?.close();
        if (created) await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    });
  }
}
