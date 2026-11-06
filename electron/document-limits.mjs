export const DOCUMENT_EXTENSIONS = Object.freeze(['.pdf', '.docx', '.xlsx', '.pptx']);
export const DOCUMENT_LIMITS = Object.freeze({ bytes: 10 * 1024 * 1024, characters: 60000, pages: 50, slides: 50,
  sheets: 20, rows: 2000, cells: 10000, zipEntries: 2048, zipBytes: 64 * 1024 * 1024,
  entryBytes: 16 * 1024 * 1024, xmlNodes: 150000, xmlDepth: 96, ocrPages: 10,
  ocrImageDimension: 1800, ocrTimeoutMs: 60000 });

export const DOCUMENT_ERRORS = Object.freeze({
  unsupported: 'Choose a PDF, DOCX, XLSX or PPTX document. Save older Office files in the modern format first.',
  too_large: 'This document exceeds the 10 MiB attachment limit. Choose a smaller document.',
  text_limit: 'This document contains more than 60,000 characters. Split it into smaller documents before attaching.',
  page_limit: 'Attach a PDF with at most 50 pages.',
  slide_limit: 'Attach a presentation with at most 50 slides.',
  workbook_limit: 'Attach a workbook with at most 20 sheets, 2,000 rows and 10,000 cells.',
  archive_limit: 'This Office document exceeds the safe archive expansion limit. Choose a smaller document.',
  encrypted: 'Password-protected documents cannot be read. Save an unencrypted copy and attach that copy.',
  no_text: 'No selectable text was found. For a scanned PDF, choose Scan PDF with OCR. For other image-only documents, attach page images or save an OCR text copy.',
  ocr_unavailable: 'Local PDF OCR requires Windows 10/11 and its Windows PowerShell runtime. Use selectable PDF text or save an OCR text copy.',
  ocr_language_missing: 'No Windows OCR language is available for your user profile. Install a language with text recognition in Windows, then try again.',
  ocr_page_limit: 'Scan PDF with OCR accepts at most 10 pages. Split this PDF into smaller documents.',
  ocr_no_text: 'OCR could not recognize text in this PDF. Try a clearer scan or attach page images to an image-capable model.',
  ocr_failed: 'Windows could not scan this PDF. Save an unencrypted standard PDF and try a clearer or smaller scan.',
  malformed: 'The document is damaged or does not match its file format. Open it in its original app and save a new copy.',
  active_content: 'This document contains macros or unsafe XML declarations. Save a plain, macro-free document and attach that copy.',
  busy: 'Two documents are already being read. Wait for them to finish before attaching another.',
  timeout: 'Reading this document took too long. Split it into a smaller document and try again.',
  memory_limit: 'This document needs too much memory to read safely. Choose a smaller document.',
  cancelled: 'Document reading cancelled.',
  parser_unavailable: 'The document reader is missing from this app. Reopen the complete Gravity release.',
  parse_failed: 'This document could not be read. Open it in its original app and save a new copy.',
});

export function documentError(code) {
  const safe = Object.hasOwn(DOCUMENT_ERRORS, code) ? code : 'parse_failed';
  return Object.assign(new Error(DOCUMENT_ERRORS[safe]), { code: safe });
}
