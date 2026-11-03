# Antigravity Studio 1.4.2

Windows x64 portable build, 3 November 2026. Companion extension version 1.0.1.

## Changes

- **Open extension setup:** Electron's recursive filesystem copy could not traverse the bundled ASAR archive and left an empty extension folder. Setup now reads and writes the archive entries explicitly. The prepared path and any Chrome-launch error appear beside the button, with manual installation instructions.
- **Qwen/Z.ai loading:** A browser job no longer waits for Chrome's overall page status to become `complete`. It polls the expected site's chat input for up to 45 seconds, including while background resources are loading. The total job budget remains bounded; cancellation, host checks, and refusal to overwrite existing conversations/drafts are preserved.
- **Website testing:** Each website card includes **Test response**. It tests that exact website with a short message, without changing the selected conversation/provider or sending project context. Status wording distinguishes detecting a chat input from verifying a reply.
- **Tool-call formatting:** Tool prompts explicitly require the entire reply as raw JSON, with progress/explanations inside `content` and an empty `tool_calls` array for a final answer. The parser still rejects embedded examples and malformed or undeclared calls. No automatic retry or execution of extracted snippets was added.

## Upgrade

1. Stop any running conversation and close the older Antigravity Studio window. Open `Antigravity-Studio-1.4.2-x64.exe` from the release folder. Existing saved app data uses the same location.
2. In **Settings → Web2API bridges → Browser connector**, start the connector and click **Open extension setup**.
3. In Chrome's `chrome://extensions/`, replace the older Antigravity Studio Browser Connector installation with the new **Load unpacked** folder shown by the app. Check that the extension version is **1.0.1**. If loading from the source `browser-extension` directory instead, use Chrome's **Reload** button after updating those files.
4. Open the extension, click **Connect to app**, and approve the request in the desktop. Keep website tabs signed in in that Chrome profile.
5. Use **Test response** for Qwen, Z.ai, or Claude. After a successful text test, select its model alias in the conversation and retry the task.

Do not assume a detected tab verifies generation. These fixes have automated fixture coverage; the user's live Qwen/Z.ai/Claude generation and exact failed Claude reply have not been verified. Website changes may need adapter-specific updates. Project-list JSON from a website is account metadata, not an assistant completion or a tool-call result.

See [system requirements](SYSTEM-REQUIREMENTS.md) for platform, Chrome, account, and task-specific dependencies, and [validation](VALIDATION.md) for checks performed.
