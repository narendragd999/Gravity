# Gravity

A portable Windows desktop workspace for AI chat, local projects, and coding agents. Connect a signed-in browser account or an API provider, then use the same connection in Gravity and other applications through its built-in local API.

## Run Gravity

Double-click **`Gravity-1.5.2-x64.exe`** in `release/`. No app installation, Node.js, Python, or Git is required to open the packaged app. Copy the executable to any folder on a supported Windows 10/11 x64 computer and launch it there.

Gravity starts its Browser Connector and local API automatically. Saved Web2API bridge profiles and a configured Gemini bridge also start with the app. Each service has its own status and startup preference; an unavailable bridge does not prevent the desktop from opening. Explicit startup preferences from an existing profile are retained.

### The easiest connection: your browser

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
| Web2API Bridges | Manage optional external services and bridge processes |
| Models & providers | Enter API keys and choose models |
| API | Copy Gravity's local API URL and access token for another app |
| Appearance | Choose a comfortable text size and theme |

Text is larger by default, with saved **100%, 110%, and 125%** size choices. Advanced bridge paths, ports, and process options are available when needed.

## Use Gravity from another app

The local API normally starts at **`http://127.0.0.1:4318/v1`**. Open its settings page to copy the current URL and generated access token. Paste them into any client that supports an OpenAI-compatible API. The token is Gravity's local access key, separate from upstream provider keys.

| Method | Endpoint | Authentication |
| --- | --- | --- |
| GET | `/health` | None; listener health only |
| GET | `/v1/models` | Gravity bearer token |
| POST | `/v1/chat/completions` | Gravity bearer token; JSON or SSE |

Use a model ID returned by `/v1/models`, such as `provider-id/model-id`. A listening API still needs a working browser or API provider to answer requests. This API serves local native clients; browser cross-origin requests are disabled. It does not expose filesystem or agent-execution endpoints.

## Portability and saved data

The runtime, UI, local API, connector server, and extension files are included. Chrome and website accounts are needed only for browser connections. External bridge runtimes and credentials are configured separately. Project command tools, compilers, and Git are needed only for tasks that use them.

Existing app data and browser-extension paths are retained when upgrading from Antigravity Studio. Credentials use Windows user encryption and should be re-entered on a different computer. The executable is portable; saved credentials and machine-specific project/tool paths are not automatically transferable. See [system requirements](docs/SYSTEM-REQUIREMENTS.md).

## Build from source

The repository also includes [Gemini Web2API and Claude Web2API source](bridges/README.md), with upstream provenance and local Claude fixes. The Chrome extension is in `browser-extension/`. These optional standalone bridge sources have their own runtimes and configuration; use Browser Connector for the setup without a separate bridge process.

Use Node.js 24 with npm on Windows:

```powershell
git clone https://github.com/narendragd999/Gravity.git
Set-Location Gravity
npm ci
npm run build
npm start
```

`npm run dev` opens the development app. `npm run dist` creates the Windows x64 portable executable. `python scripts/source-archive.py` creates the matching source ZIP; `node scripts/verify-package.mjs` verifies both artifacts and writes SHA-256 checksums.

```powershell
npm test
npm run build
npm run test:desktop
```

Tests use local fixtures and disposable profiles. See [validation results](docs/VALIDATION.md) for their scope.

[Setup and API examples](docs/SETUP.md) · [Browser setup](docs/BROWSER-CONNECTOR.md) · [Gravity 1.5.2 upgrade](docs/RELEASE-1.5.2.md) · [Advanced Web2API](docs/UNIVERSAL-WEB2API.md) · [Permissions](docs/PERMISSIONS.md)

Gravity is an independent application. It is not Google's Antigravity binary or private agent backend. See [research and scope](docs/reverse-engineering.md).
