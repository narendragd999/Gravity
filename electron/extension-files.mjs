import fs from 'node:fs/promises';
import path from 'node:path';

async function existingEntry(filename) {
  try { return await fs.lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Electron can read ASAR entries, but fs.cp cannot traverse their virtual paths.
export async function copyBrowserExtension(source, destination) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  const target = await existingEntry(destination);
  if (target && (!target.isDirectory() || target.isSymbolicLink())) throw new Error('The extension destination must be a regular folder.');
  await fs.mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyBrowserExtension(from, to);
    else if (entry.isFile()) {
      const existing = await existingEntry(to);
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error(`The extension destination contains a redirected file: ${entry.name}`);
      await fs.writeFile(to, await fs.readFile(from));
    }
    else throw new Error(`Unsupported browser extension entry: ${entry.name}`);
  }
}

// Refresh old install folders too, so Chrome's Reload button updates an existing
// installation. New installations use one stable path across desktop versions.
export async function prepareBrowserExtensionFolders(source, base) {
  const existing = await existingEntry(base);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('The extension base must be a regular folder.');
  await fs.mkdir(base, { recursive: true });
  const destination = path.join(base, 'current');
  await copyBrowserExtension(source, destination);
  const updatedPaths = [];
  for (const entry of await fs.readdir(base, { withFileTypes: true })) {
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(base, entry.name);
    const manifestPath = path.join(directory, 'manifest.json');
    const manifestEntry = await existingEntry(manifestPath);
    if (!manifestEntry?.isFile() || manifestEntry.isSymbolicLink()) continue;
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch { continue; }
    if (manifest.name !== 'Antigravity Studio Browser Connector') continue;
    await copyBrowserExtension(source, directory);
    updatedPaths.push(directory);
  }
  return { path: destination, updatedPaths };
}
