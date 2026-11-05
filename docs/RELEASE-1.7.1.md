# Gravity 1.7.1

This release fixes the composer attachment picker and the repeated ChatGPT verification handoff. It applies selected patterns from a pinned review of OpenCode's public desktop, composer and session source. The earlier 1.7.0 interface and improvement-plan features are retained.

## Changes

- The composer **+** opens the Windows multiple-file picker. Text/code attachments work in projectless Chat, show removable chips and persist as read-only message snapshots. Native selections grant opaque, bounded file IDs; changed files are rejected before sending, and attachments do not extend project/tool permissions.
- Text is limited to four files or project excerpts and 60,000 combined characters; each picked text file is at most 40 KiB and 500 lines. PNG/JPEG/WebP/GIF are capability-checked and signature-checked. PDF, Office and ZIP extraction are not included.
- Picker cancellation retains existing attachments. A late picker result cannot attach to a different draft. Sent attachment text survives backup export/import; native IDs, absolute paths and executable approvals are not imported.
- Workspace **Open folder** both adds and selects the returned project. Chat explains that Build is needed for project editing.
- ChatGPT verification keeps one browser/page open for a cumulative maximum of two minutes while the user completes a security check. It performs no reload, browser relaunch or prompt submission during that wait. Cancellation settles owned work and preserves existing website accounts.
- A persistent security check offers **Use your normal Chrome tab** through Browser Connector. The browser sandbox stays enabled. The shortcut switches directly only when the extension and selected site are ready; otherwise it opens setup.
- Failed requests remain visibly failed even when the local website service is ready. Recognized website errors retain fixed, sanitized messages and codes, including account expiry, rate limits, security checks and incomplete replies.

See [OpenCode standardization](OPENCODE-STANDARDIZATION.md) for source references, applied standards and remaining architecture priorities. This is a selected-source comparison, not full OpenCode parity. [Attachment instructions](SETUP.md#attach-files-to-a-chat), [ChatGPT recovery](SETUP.md#chatgpt-keeps-asking-for-verification), and the [included Claude guide](CLAUDE-WEB2API-WINDOWS.md) explain setup.

## Upgrade

1. Close the older Gravity app after finishing or stopping its chats.
2. Open **Gravity-1.7.1-x64.exe**. Existing app data and saved website profiles are reused.
3. Use **+** to attach files. Use **Settings → Get started** for website setup, and keep the verification browser open when asked to complete a security check.

## Validation

All **357 Node tests**, native desktop smoke, **18 isolated Electron DOM checks**, TypeScript/Vite production build and portable packaging passed. The executable also launched from an isolated folder with spaces without developer runtimes on PATH, and its bundled website service completed in-app setup. The native attachment flow and light/dark layouts were visually inspected. See [VALIDATION.md](VALIDATION.md).

Automated checks use disposable profiles and local providers. Current-account ChatGPT/Qwen/DeepSeek/Z.ai or Claude authentication and generation, and a fresh Windows virtual machine, remain acceptance checks. Website-controlled CAPTCHA requests cannot be guaranteed to stop by an application update.
