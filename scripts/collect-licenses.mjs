import fs from 'node:fs/promises';
import path from 'node:path';
const seen = new Set(), records = [];
async function packages(root) {
  let entries; try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const location = path.join(root, entry.name);
    if (entry.name.startsWith('@')) { await packages(location); continue; }
    let actual, pkg; try { actual = await fs.realpath(location); pkg = JSON.parse(await fs.readFile(path.join(actual, 'package.json'), 'utf8')); } catch { continue; }
    const id = `${pkg.name}@${pkg.version}`; if (seen.has(id)) continue; seen.add(id);
    const names = (await fs.readdir(actual)).filter(name => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
    let text = `\n${'='.repeat(72)}\n${id}\nDeclared license: ${JSON.stringify(pkg.license || pkg.licenses || 'See package')}\n`;
    for (const name of names) { const file = path.join(actual, name); if ((await fs.stat(file)).isFile()) text += `\n${name}\n${await fs.readFile(file, 'utf8')}\n`; }
    records.push({ id, text }); await packages(path.join(actual, 'node_modules'));
  }
}
await packages('node_modules');
try { for (const entry of await fs.readdir('node_modules/.pnpm', { withFileTypes: true })) if (entry.isDirectory()) await packages(path.join('node_modules/.pnpm', entry.name, 'node_modules')); } catch { /* npm uses a flattened installation. */ }
records.sort((a,b) => a.id.localeCompare(b.id));
await fs.writeFile('THIRD_PARTY_LICENSES.txt', 'Dependency notices for Gravity, including build-time tooling.\n'+records.map(r=>r.text).join('\n'));
console.log(`Collected license notices for ${records.length} installed packages.`);
