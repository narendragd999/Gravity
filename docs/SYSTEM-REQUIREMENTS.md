# System requirements and portability

The current distribution is a Windows x64 portable executable with Electron and its Node runtime included. The target is Windows 10/11 x64. It is not a universal binary: macOS, Linux, Windows ARM, and other operating-system versions have not been built or validated. A clean-machine installation test has not been performed.

## What is included

Gravity 1.9.0 includes the desktop interface, local API gateway, browser connector server, extension files, PDF/Office text readers, and the separate DeepSeek/Qwen/ChatGPT/Z.ai website service with its Node runtime. Starting the desktop, reading supported document text and using those website connections does not require separately installing Node.js, Python, Office or Git. Local Scan PDF uses Windows components already on the machine.

## What the machine still needs

- Google Chrome 120 or later, installed in a standard Windows location, with permission to load the companion extension for **Use your normal Chrome**. Organization-managed Chrome may prohibit unpacked extensions. The optional **Separate saved website profile** setup uses an installed Chrome or Edge browser; it does not require the extension.
- Internet access and a working signed-in account for each website used. Website limits, challenges, model availability, and layout changes still apply.
- Local port 4319 available for the browser connector. The API starts on port 4318 by default; its port and startup preference can be changed separately.
- Windows PowerShell for application command tools. **Scan PDF** specifically needs Windows PowerShell 5.1, Windows PDF rendering/OCR support and an installed user-profile language with text recognition. No downloaded OCR model is required. Other Python interpreters, compilers, package managers or tools requested by an agent task must be available separately; the bundled document reader does not supply a general Python/Office environment. The Changes panel requires Git.
- Separately installed/configured services for external bridges, Ollama, or other local model providers. Remote APIs require their own provider configuration and credentials.

Website model aliases choose a website. They do not supply a local model, an offline service, or native provider tool support. Browser application tools use a structured text protocol and remain subject to the desktop's permissions.

## Attachment and draft limits

The **+** picker accepts regular files up to 10 MiB, with four files/project excerpts and 60,000 context characters combined. PDF/Office text extraction supports PDF, DOCX, XLSX and PPTX with structural limits: 50 PDF pages, 50 slides, or 20 workbook sheets/2,000 rows/10,000 cells. Unknown or unreadable formats can provide metadata and at most 1,024 bytes of hex preview; they are not fully decoded or sent as native document uploads. Click a file chip to review literal text before sending.

**Scan PDF** is explicit, PDF-only OCR: 10 MiB, 10 pages, rendered image dimensions up to 1,800 pixels, a 60-second deadline, and output within the combined character budget. At most two document/OCR readers run concurrently. OCR language availability, scan quality and layout affect results; check recognized names and numbers. Selectable PDF text does not require Windows OCR.

PNG/JPEG/GIF/WebP image input needs an image-capable model and is limited to eight images, 8 MiB each and 24 MiB combined encoded data. The image icon, paste and drop handle supported images only. A supported image selected with **+** on a text-only connection provides metadata/hex preview instead of image interpretation. See the [setup guide](SETUP.md#attach-files-to-a-chat) for the input paths.

Per-chat drafts use encrypted local storage, with 128 drafts and 64 MiB of combined draft data before encryption. File metadata restored after reload/restart requires explicit reselection or removal before sending. If saving fails, the app keeps unsaved work in the running session; its close dialog offers **Keep editing** or **Discard unsaved drafts**. Damaged/undecryptable draft files remain preserved.

## Moving to another computer

The executable can be copied, but new app profiles are stored separately in `%APPDATA%\Gravity`. Existing Antigravity Studio profiles continue using `%APPDATA%\Antigravity Studio` to retain saved data and the installed extension path. Project and external-tool paths are machine-specific. Saved credentials and `drafts.json` use the Windows user's encryption context; copying app data is not a credential or draft migration mechanism. Re-enter credentials and pair/sign in to websites on the destination computer. Moving the executable on the same Windows account keeps its app-data profile available.

## Checking a website

`Tab detected` means a supported chat input was found. It does not prove that a completed response can be produced. Use **Settings → Browser Connector → Test response** for the website. A passed test verifies that single text reply, not future availability or successful application tool calls.

**Connections** shows the ways Gravity gets model responses and their saved response-check results. **Share models** exposes connected models to another app on the same computer while Gravity is open; it does not supply a provider account or local model server. **Save & discover models** saves the IDs advertised by your configured service, without proving generation access. Live Gemini availability depends on your own account/service test. Release signature trust is a separate [signing configuration](RELEASE-SIGNING.md); bundled update support does not establish that an executable is signed.
