# Antigravity Studio

An independent Windows desktop coding-agent workspace inspired by the current public Google Antigravity design. Connect your own model endpoints, work across local projects, review agent changes, and expose your configured models through one local API.

This is original application code, not Google's desktop binary or private agent backend. See [research and parity](docs/reverse-engineering.md) for what was inspected, implemented, and left outside scope.

## Start from source

The Windows build output is `release/Antigravity-Studio-1.4.3-x64.exe`; create it with `npm run dist`. The portable executable includes the desktop runtime. [Browser accounts](docs/BROWSER-CONNECTOR.md) · [Upgrade instructions](docs/RELEASE-1.4.3.md) · [System requirements](docs/SYSTEM-REQUIREMENTS.md) · [Setup guide](docs/SETUP.md) · [Universal Web2API](docs/UNIVERSAL-WEB2API.md) · [Permissions](docs/PERMISSIONS.md) · [Validation results](docs/VALIDATION.md).

Use Node.js 24 with npm on Windows. Git is optional for source-change inspection.

```powershell
git clone https://github.com/narendragd999/Gravity.git
Set-Location Gravity
npm install
npm run build
npm start
```

For development with the local Vite server and Electron:

```powershell
npm run dev
```

For a Windows x64 portable package, run `npm run dist`. Build outputs go into `release/`; creating a package does not install the app. If a portable executable is supplied separately, launch it and follow the first-run steps below. No Node installation is required to run a packaged executable.

## Version 1.4.3 extension compatibility and loading

The desktop displays its version and the connected extension version, and blocks outdated extensions with upgrade instructions. **Open extension setup** updates recognized old extension folders and prepares a stable `current` folder for new installs; reload the extension in Chrome to activate its updated files. Browser probes now inject immediately and have bounded waits, so loading resources cannot stall polling indefinitely. See [upgrade steps](docs/RELEASE-1.4.3.md).

## Version 1.4.2 browser fixes

Packaged extension setup now extracts the complete extension folder and shows its path beside the setup button. Browser jobs check the chat input even while Chrome reports the page as loading, and each website card has a **Test response** action. Tool prompts require a whole-response JSON envelope with explanations inside `content`; embedded examples are still rejected. See [upgrade steps and limits](docs/RELEASE-1.4.2.md).

## Version 1.4.1 connection fix

Model discovery lists IDs; it does not establish that a website or model can respond. **Test model** now verifies generation and names the exact provider, endpoint, and model tested. Settings opens on the current chat provider and offers **Use in this chat** to apply a different saved provider. The chat displays its selected connection and offers **Use Claude in Chrome** after a failed local Claude request. See [upgrade and Claude recovery steps](docs/RELEASE-1.4.1.md).

## First run

To use accounts already signed into Chrome, open **Settings → Web2API bridges → Browser connector**. The app prepares its companion extension and automatically creates model routes for Claude, ChatGPT, DeepSeek, Qwen, Z.ai, and Gemini. Chrome requires a one-time extension installation, then explicit pairing approval in the desktop. No cookie export, Python, or Git setup is required for this method. See [browser setup and current limitations](docs/BROWSER-CONNECTOR.md). The website adapters are experimental; fixture tests do not establish live account compatibility.

1. Open **Settings → Models & providers**. Select a preset or add a provider, choose its protocol, enter its base URL and API key if required, and save.
2. Use **Discover models**, or enter exact custom model IDs. Choose a default model and save again. **Test model** sends a short message to the saved default model and requires a nonempty response. Use **Use in this chat** to apply the selected provider to your conversation.
3. Open a project folder and start a conversation. Choose **Plan** to inspect and plan, or **Build** to propose edits and commands.
4. Use the permission selector below the message box to choose how agent actions are approved. **Ask for approval** is the default; review proposed file contents and shell commands before approving them. Use the adjacent Files, Changes, Terminal, and Artifacts panels to inspect the work.

The shipped Gemini and Ollama entries are connection presets. They do not install a model or provide credentials, and the desktop does not fabricate model responses. A configured, reachable upstream service is required for inference.

## Included workflows

- Saved projects and conversations, concurrent agent runs, streaming messages, cancellation, and light/dark themes.
- A local Monaco editor, content search, Git status/diff inspection, and a bounded command panel.
- Plan/Build agent modes, per-conversation approval permissions, reviewable writes, stale-content checks, file backups, and Markdown artifacts.
- OpenAI-compatible, native Anthropic, and native Gemini providers with custom base URLs, model IDs, and request headers.
- A token-authenticated loopback API gateway and optional management of a local `gemini-web2api` process.
- An included Chrome companion extension with website adapters for Claude, ChatGPT, DeepSeek, Qwen, Z.ai, and Gemini, using the profile's existing sign-ins after one-time installation and desktop pairing.
- Configurable Web2API bridge profiles for external services and managed foreground executables, with encrypted environment settings, readiness checks, cancellation, and process cleanup. The universal headless launcher can route several backends through the same API.

The included [browser connector](docs/BROWSER-CONNECTOR.md) supplies adapters for all six websites without separately installing a Web2API server. These adapters are experimental: local fixture tests do not prove live website or account compatibility, and model selection remains in each website. For other services or a process-based connection, use a separately prepared adapter implementing a supported API format; see [connection steps](docs/UNIVERSAL-WEB2API.md) and [source-reviewed candidates](docs/WEB2API-RESEARCH.md). A process bridge profile manages that existing adapter. The supplied Claude repository has unresolved implementation issues and is not bundled as a verified working adapter.

## Local API

In **Settings → API gateway**, choose a port, copy the generated access token, and select **Save & start gateway**. The default base URL is `http://127.0.0.1:4318/v1`.

| Method | Endpoint | Authentication |
| --- | --- | --- |
| GET | `/health` | None; process health only |
| GET | `/v1/models` | Gateway bearer token |
| POST | `/v1/chat/completions` | Gateway bearer token; JSON or SSE |

Model listing returns IDs such as `provider-id/model-id`. Use those IDs to select the provider explicitly. The gateway serves local native clients and CLI tools; browser cross-origin requests are disabled. It does not expose filesystem or agent-execution endpoints.

See [complete setup and API examples](docs/SETUP.md), including native provider configuration, custom models, Gemini bridge setup, and the standalone gateway.

## Validation and limits

```powershell
npm test
npm run build
npm run test:desktop
```

Tests exercise local HTTP protocol fixtures, authentication/routing, streaming, file boundaries and backups, process cancellation, agent approvals, persistence, and bridge lifecycle. They do not establish valid live provider credentials, upstream model availability, or successful Gemini account inference.

All 132 automated tests passed, including 9 generation-test checks, 4 provider-switch state checks, 15 browser-connector tests, 15 extension tests, 11 permission-policy tests, 15 configurable bridge tests, and 10 headless universal-service tests. The native Electron smoke test verifies desktop permissions, bridge lifecycle, encrypted settings, automatic browser-provider setup, pairing, all six site statuses, a simulated browser response, and revocation. Another 13 synthetic Electron DOM checks cover the six website adapters and their safeguards. Separately, the existing local Gemini bridge returned a real `READY` response on 2 November 2026. The new Chrome adapters have not been verified against live accounts. See [validation details](docs/VALIDATION.md) for the scope of these checks.

The command panel is a non-interactive shell runner, not a PTY. Approved commands execute with your operating-system permissions. This app does not include Google's private agent harness, extension marketplace, browser agent, remote control, or enterprise services. API keys saved in desktop settings use OS-backed encryption; the Gemini process temporarily needs a separate private launch configuration. Storage details are in [SETUP.md](docs/SETUP.md#local-data-and-recovery).

## Code map

`src/` contains the renderer. `electron/` contains the desktop entry point, IPC boundary, state store, provider adapters, agent loop, workspace tools, gateway, and Gemini bridge. `tests/` contains the automated checks. `docs/CONTRACT.md` describes the renderer/backend interface.

The supplied repositories, [REA](https://github.com/morluto/rea) and [gemini-web2api](https://github.com/ikhsan3adi/gemini-web2api), were studied as separate reference projects. Their source is not bundled into this app.
