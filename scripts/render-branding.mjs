import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-only preview export. Rasterize the existing SVG with Skia instead of
// waiting for animation frames/painting in a hidden browser window.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'docs', 'branding');
let createCanvas, loadImage;
try { ({ createCanvas, loadImage } = await import('@napi-rs/canvas')); }
catch { throw new Error('Branding previews need the optional canvas dependency. Run npm ci with optional dependencies, then node scripts/render-branding.mjs.'); }

for (const [name, width, height] of [['orbitdesk-icon', 512, 512], ['orbitdesk-logo', 900, 250]]) {
  const source = await fs.readFile(path.join(directory, `${name}.svg`));
  const image = await loadImage(source);
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').drawImage(image, 0, 0, width, height);
  await fs.writeFile(path.join(directory, `${name}.png`), await canvas.encode('png'));
  console.log(`Rendered ${name}.png (${width} × ${height}).`);
}
