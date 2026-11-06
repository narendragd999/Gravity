import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export async function packageDocuments({ outputDir = path.resolve('release/document-build') } = {}) {
  await fs.mkdir(outputDir, { recursive: true });
  await build({ entryPoints: ['electron/document-worker.mjs'], outfile: path.join(outputDir, 'document-worker.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'bundle',
    external: ['@napi-rs/canvas'], banner: { js: "import {createRequire as documentCreateRequire} from 'node:module'; const require = documentCreateRequire(import.meta.url);" },
    logLevel: 'warning' });
  await fs.copyFile(fileURLToPath(import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')), path.join(outputDir, 'pdf.worker.mjs'));
  return outputDir;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await packageDocuments());
