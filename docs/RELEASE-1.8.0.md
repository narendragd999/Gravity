# Gravity 1.8.0

Prepared on 6 November 2026. This release adds PDF/Office document attachments, improves security-check handling in normal Chrome, and recognizes verified Z.ai answer/thinking response phases. The portable product and saved-data identity remain Gravity; OrbitDesk is a naming proposal documented separately.

## Documents

- **+** accepts PDF, DOCX, XLSX and PPTX alongside existing UTF-8 text/code and supported images. Document chips identify extracted text and show page/sheet/slide counts where applicable.
- Text extraction runs locally in an owned reader process using the bundled Node runtime. The portable executable does not need Python, Microsoft Office, a PDF utility or system Node for this feature.
- Word paragraphs and tables, PDF selectable text, PowerPoint slide text in presentation order, and Excel stored cell values/formula caches become read-only message snapshots. They work in projectless Chat and do not expand project/tool permissions.
- Document byte/page/slide/sheet/row/cell/XML/archive/output limits are enforced. Unsupported, encrypted, malformed, macro-containing and image-only documents receive fixed actionable errors. No links or external document resources are fetched, and no formulas or macros are executed.
- **Reading… → Cancel** stops the owned reader. Navigation, a changed draft or app closure also cancels work. Original files are revision-checked before sending, and accepted snapshots survive history and nonsecret backup export/import.

## ChatGPT and normal Chrome

- A challenged Browser Connector task tab is shown once and observed on the same page for a cumulative wait of up to two minutes. The user completes the website check; Gravity does not click or solve it.
- A security-timeout tab can be retained for a later explicit request. Reuse requires the expected website/path and a fresh history/draft/readiness check before one submission. Cancellation and service-worker restart never replay a prompt.
- Website-backed response tests allow up to three minutes so the manual wait is not cut off by the ordinary API-test deadline. Other API tests retain their 90-second ceiling.
- The dedicated bridge request browser is brought forward when its security check needs attention. Browser security and the sandbox remain enabled.

## Z.ai responses

The website can finish a conversation while Gravity rejects its response structure. The bridge decoder now recognizes the public frontend's verified `answer` and `thinking` phases and boolean `done` marker, keeps reasoning out of the accepted answer, and preserves legacy UTF-16 edit offsets. Ambiguous snapshots, website tool phases and structured agent blocks receive a clear refusal. Public source provenance and focused tests establish the decoder behavior; a signed-in GLM 5.3 response still needs live verification.

## Upgrade and use

1. Finish or stop chats and close the older Gravity app.
2. Open **Gravity-1.8.0-x64.exe**. Existing saved app data and website profiles are retained.
3. To attach a document, click **+**, choose it, wait for the text chip, type your request and send.
4. If using Browser Connector, prepare the updated extension from **Open extension setup**, then click **Reload** on Gravity Browser Connector in Chrome. Updated source files take effect after Chrome reloads the extension.

See [attachment instructions and limits](SETUP.md#attach-files-to-a-chat), [provider/gateway/browser explanation](CONNECTIONS-EXPLAINED.md), [Claude setup](CLAUDE-WEB2API-WINDOWS.md), and [product direction and naming](PRODUCT-DIRECTION-2026-11-06.md).

## Validation status

**385 Node tests, native desktop smoke, the 18 isolated Electron DOM checks, Windows x64 packaging, and portable document/website-service smoke passed.** The user confirmed a live ChatGPT Browser Connector reply of **OK**. Live security-challenge recovery and the signed-in Z.ai GLM 5.3 account remain acceptance checks. [VALIDATION.md](VALIDATION.md) records the evidence and limits. Local fixtures do not establish that every website account will accept a browser session or stop requesting CAPTCHA.
