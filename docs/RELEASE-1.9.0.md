# Gravity 1.9.0

This release implements the five priorities from the product improvement plan and fixes the reported Gemini empty-answer and redirected-file attachment errors.

## Changes

- **Persistent drafts:** unsent text, images and selected project excerpts are encrypted locally per chat or new-project draft. Native file metadata restores with a visible **Reselect file** requirement. Failed saves remain tracked across chats; closing offers **Keep editing** or an explicit discard, and failed destination writes retain the source draft.
- **Cleaner connections:** the Connections overview separates normal Chrome, API/local models and a separate saved website profile. Saved connection cards offer response tests, configuration and deliberate chat selection. **Share models** explains the local API for other applications. **Save & discover models** saves the current model list without sending a prompt or changing an existing chat.
- **Saved model checks:** each model retains its latest response-test result, time, duration and last success/failure. Credential or endpoint changes invalidate the old checks. A failed model test never becomes a successful test merely because discovery works.
- **File previews and OCR:** **+** accepts any file type within the file limits. Text and PDF/DOCX/XLSX/PPTX readers provide literal extracted snapshots; other formats provide clearly labelled metadata and a bounded hex preview. **Preview** shows the exact read-only content. **Scan PDF** uses cancellable Windows OCR for scanned pages. Explicit native selections work through legitimate Windows Downloads/OneDrive junctions; file identity and contents are still rechecked before sending.
- **Controlled updates and signing preparation:** the Updates page checks official stable releases. Verified downloads require a configured publisher certificate, SHA-256 and matching Windows product version, and never execute automatically. Pinned Windows acceptance and manual signed-draft workflows include locked root/website dependencies, Go bridge tests and portable acceptance.
- **Gemini failure reporting:** empty, reasoning-only, blocked, malformed-tool and substituted-model replies produce failures instead of fake successful answers. Failed request text is excluded from future model history. The included Go bridge validates tool batches and streaming output; zero/negative retry settings make one request. Google model presets no longer contain obsolete hardcoded IDs.

## Run and setup

1. Close an older Gravity window after saving work.
2. Double-click `Gravity-1.9.0-x64.exe`. Existing saved accounts and chats remain in the stable application-data directory.
3. Open **Connections** and choose your connection method. For Google API errors mentioning Gemini 1.5, open **Models & providers**, use **Save & discover models**, choose an available default, save it and select it explicitly in your chat.
4. Use **+** for files, **Preview** to inspect their content, and **Scan PDF** for scanned PDFs. After restart, reselect each native file or remove its restored chip before sending.

For the optional included Gemini bridge, use the separately built unsigned `Gravity-Gemini-Web2API-1.9.0-x64.exe` and explicitly select it in **Web2API Bridges → Gemini adapter**. Source edits do not update an arbitrary external executable already selected on your computer. See [Gemini setup](GEMINI.md), [attachment/draft setup](SETUP.md), and [signing setup](RELEASE-SIGNING.md).

## Limits

- Four files/project excerpts, 10 MiB per generic file, and 60,000 combined extracted characters. Oversized input is rejected without silent truncation. Binary metadata/hex preview is not a full native upload or decoded document.
- Eight supported images, 8 MiB each and 24 MiB combined encoded data; image pixels require a compatible model. On a text-only model, picker images provide metadata/hex context.
- PDF OCR: 10 pages, 1800-pixel render dimension, 60 seconds and 60,000 characters, with two shared reader jobs. OCR uses installed Windows recognition languages and may make recognition errors.
- Encrypted drafts: 128 records and 64 MiB combined plaintext data. Native paths and live attachment IDs are never persisted.

The development executable and optional Gemini bridge remain **unsigned** because no publisher certificate has been configured. Checking updates works; verified downloads fail closed until signing is configured. Website-controlled CAPTCHA can still recur and must be completed by the user. Live Gemini account compatibility and a fresh Windows virtual machine are separate acceptance checks.

See [validation](VALIDATION.md) for the executed acceptance results.
