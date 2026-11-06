import { extractDocument } from './document-extract.mjs';
import { DOCUMENT_ERRORS } from './document-limits.mjs';

// Parsing never follows hyperlinks, relationships, fonts, or remote resources.
globalThis.fetch = async () => { throw new Error('Document network access is disabled.'); };
console.warn = () => {}; console.log = () => {};
process.once('disconnect', () => process.exit(0));
process.once('message', async input => {
  let message;
  try {
    const result = await extractDocument(input?.bytes, input?.extension, { pdfWorkerPath: input?.pdfWorkerPath });
    message = { ok: true, result };
  } catch (error) {
    message = { ok: false, code: Object.hasOwn(DOCUMENT_ERRORS, error?.code) ? error.code : 'parse_failed' };
  }
  if (!process.connected) return;
  process.send(message, () => { if (process.connected) process.disconnect(); process.exit(0); });
});
