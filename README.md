# Gravity

A portable Windows desktop workspace for AI chat, local projects, and coding agents. Connect a signed-in browser account or an API provider, then use the same connection in Gravity and other applications through its built-in local API.

## Run Gravity

Double-click **`Gravity-1.7.0-x64.exe`** in `release/`. No app installation, Node.js, Python, or Git is required. The website service and its Node runtime are included in this executable. Copy it to any folder on a supported Windows 10/11 x64 computer and launch it there. Install Chrome or Edge to connect a website account.

Gravity starts its Browser Connector and local API automatically. Saved Web2API bridge profiles and a configured Gemini bridge also start with the app. Each service has its own status and startup preference; an unavailable bridge does not prevent the desktop from opening. Explicit startup preferences from an existing profile are retained.

### One-click website connection

1. Open **Settings → Get started** or **Web2API Bridges**.
2. Choose **Z.ai, ChatGPT, DeepSeek, or Qwen** and click **Connect & start**.
3. If sign-in is needed, complete it yourself in the separate browser that opens. Open a **new, empty chat**, then **close all windows of that separate browser**. Gravity checks the saved session and continues automatically. This is the same flow for all four websites.
4. Once the service is ready, click **Test response** to check a real answer, then **Use in this chat** if it is not already selected.

Gravity fills the local connection key, saves its managed service, discovers the available model, and selects it for an idle chat. Saved sign-ins are reused, and the service starts with Gravity on later launches. **Sign in again** refreshes an expired website session. Choose Chrome or Edge under **Browser for the next sign-in**; existing accounts retain their browser. Setup sends no chat prompts; **Test response** sends a short message and uses website quota. Service readiness alone does not verify generation.

### Optional Browser Connector extension

1. Open **Settings → Browser Connector → Open extension setup**.
2. In Chrome, enable **Developer mode**, choose **Load unpacked**, and select the prepared folder. Its path is copied for you.
3. Open **Gravity Browser Connector** in Chrome, select **Connect to app**, and approve the matching request in Gravity.
4. Sign in to the website you want to use, choose it in Gravity, and use **Test response** to check the connection.

Chrome requires this one-time extension installation and approval. Gravity remembers the approved extension across normal restarts. No cookie export, API key, configuration file, or separate Web2API server is needed for browser connections. Website sign-ins stay in Chrome.

The included adapters cover Claude, ChatGPT, DeepSeek, Qwen, Z.ai, and Gemini. They automate the websites' visible interfaces; website changes and account limits can affect them. Select the actual model on the website. Local fixture tests do not establish live compatibility with every account.

### Or connect an API provider

Open **Settings → Models & providers**, select a provider preset, enter its API key and model, and save. Use **Test model**, then **Use in this chat**. Custom endpoints and headers are available under advanced connection settings. Local providers such as Ollama still need their own running model service.

## Clear, separate settings

| Page | Purpose |
| --- | --- |
| Get started | Choose the quickest connection method |
| Browser Connector | Connect accounts already signed into Chrome |
| Web2API Bridges | Connect the four bundled websites; manage other bridges under Advanced |
| Models & providers | Enter API keys and choose models |
| API | Copy Gravity's local API URL and access token for another app |
| Appearance | Choose a comfortable text size and theme |

The desktop keeps projects and chats in a compact sidebar, with a focused conversation and composer. Click **Connections** for setup, or expand **Connection details** beside the composer for provider status and response-test history. Recovery controls stay visible when needed.

Text is larger by default, with saved **100%, 110%, and 125%** size choices and neutral light/dark themes. Advanced bridge paths, ports, and process options are available when needed.

## Use Gravity from another app

The local API normally starts at **`http://127.0.0.1:4318/v1`**. Open its settings page to copy the current URL and generated access token. Paste them into any client that supports an OpenAI-compatible API. The token is Gravity's local access key, separate from upstream provider keys.

| Method | Endpoint | Authentication |
| --- | --- | --- |
| GET | `/health` | None; listener health only |
| GET | `/v1/models` | Gravity bearer token |
| POST | `/v1/chat/completions` | Gravity bearer token; JSON or SSE |

Use a model ID returned by `/v1/models`, such as `provider-id/model-id`. A listening API still needs a working browser or API provider to answer requests. This API serves local native clients; browser cross-origin requests are disabled. It does not expose filesystem or agent-execution endpoints.

## Portability and saved data

The runtime, UI, local API, four-website service, connector server, and extension files are included. The optional Gemini and Claude standalone bridges need separate runtimes and credentials. Project command tools, compilers, and Git are needed only for tasks that use them.

Existing app data and browser-extension paths are retained when upgrading from Antigravity Studio. Website setup uses a permanent folder in the active Gravity user-data directory. Recognized older companion sessions are migrated when their browsers and service are closed; keep the original companion folder until migration succeeds. If migration is pending, use **Settings → Appearance → Migrate saved website data**.

Provider credentials stored in desktop state use Windows user encryption. Standalone bridge configuration also contains private session tokens and must be protected; it is not an encrypted backup. **Export backup** saves conversations and nonsecret API settings, not website sign-ins or credentials. Set up authentication again on another computer. See [local data and recovery](docs/SETUP.md#local-data-and-recovery) and [system requirements](docs/SYSTEM-REQUIREMENTS.md).

## Build from source

The repository includes [standalone Web2API sources](bridges/README.md) for Gemini/Claude and the new [DeepSeek, Qwen, ChatGPT, and Z.ai bridge](docs/MULTI-WEB2API.md). The new bridge uses direct requests or dedicated website profiles, exposes `http://127.0.0.1:4320/v1`, and has no Browser Connector extension dependency. Each standalone service has its own runtime and private configuration.

Gravity 1.7 adds normal-browser sign-in for all four standalone websites, staged recovery and safe diagnostics, Chat mode, capability checks, saved-data migration and backups, and project context/review/Undo/run guidance. See [release notes](docs/RELEASE-1.7.0.md) and the [included Claude Web2API setup guide](docs/CLAUDE-WEB2API-WINDOWS.md).

Use Node.js 24 with npm on Windows:

```powershell
git clone https://github.com/narendragd999/Gravity.git
Set-Location Gravity
npm ci
npm ci --prefix bridges/multi-web2api
npm run build
npm start
```

`npm run dev` opens the development app. To use the website setup UI in a source launch, first run `node scripts/package-web2api.mjs` with a Windows Node installation that has its adjacent `LICENSE`; this prepares `release/Gravity-Web2API`. `npm run dist` creates the Windows x64 portable executable and prepares its bundled website runtime. `python scripts/source-archive.py` creates the matching source ZIP; `node scripts/verify-package.mjs` verifies both artifacts and writes SHA-256 checksums.

```powershell
npm test
npm run build
npm run test:desktop
```

Tests use local fixtures and disposable profiles. See [validation results](docs/VALIDATION.md) for their scope.

[Setup and API examples](docs/SETUP.md) · [Browser setup](docs/BROWSER-CONNECTOR.md) · [Gravity 1.7.0 release](docs/RELEASE-1.7.0.md) · [Advanced Web2API](docs/UNIVERSAL-WEB2API.md) · [Permissions](docs/PERMISSIONS.md)

Gravity is an independent application. It is not Google's Antigravity binary or private agent backend. See [research and scope](docs/reverse-engineering.md).
