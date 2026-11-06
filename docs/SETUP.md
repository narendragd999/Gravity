# Setup and operation

## Run the desktop

Double-click **`Gravity-1.8.0-x64.exe`** to run the portable Windows app. No app installation or developer runtime is required. The DeepSeek, Qwen, ChatGPT, and Z.ai service is bundled with its Node runtime. Install Chrome or Edge for website sign-in; a companion folder is not required. For source development, use Node.js 24, run `npm ci`, `npm ci --prefix bridges/multi-web2api`, `npm run build`, and `npm start` in the repository. Git is needed for Git changes, commits, and branches; the editor, chat, and direct file operations work without Git.

`npm run dev` starts Vite on `127.0.0.1:5173` and then opens Electron. `npm run dist` builds a Windows x64 portable executable into `release/`, including the website runtime. `npm run pack` creates an unpacked desktop distribution from existing inputs; run `npm run dist` first to prepare those inputs and the bundled website service.

For the website setup UI during source development, run `node scripts/package-web2api.mjs` once to prepare `release/Gravity-Web2API`. Use a Windows Node installation with its adjacent `LICENSE` for this packaging command. The regular packaged executable needs no such step.

A packaged executable still needs a usable website account or model API connection. The optional standalone Gemini and Claude bridges are separate from the four bundled websites. See the [Claude Windows guide](CLAUDE-WEB2API-WINDOWS.md) for the included Python bridge, or [connections explained](CONNECTIONS-EXPLAINED.md) for the difference between a model provider, Gravity's local API, and the two browser connection methods.

## Connect a website with minimum configuration

1. Open **Settings → Get started** or **Web2API Bridges**.
2. Choose **DeepSeek**, **Qwen**, **ChatGPT**, or **Z.ai**. If needed, choose an installed browser under **Browser for the next sign-in**.
3. Click **Connect & start**.
4. Sign in yourself in the separate browser that opens and complete any security checks. Open a **new, empty chat**, then **close all windows of that separate browser**. Gravity reopens the saved profile to check it, then starts the service automatically. If that verification browser asks for a security check, keep it open while completing the check.
5. When the service is ready, click **Test response**. This sends one short message and may use account quota or appear in website history. Click **Use in this chat** if the connection is not already selected.

The same close-browser flow applies to all four websites on Windows. No extension, pasted cookie, API key, terminal command, or configuration file is needed for this setup. DeepSeek/Qwen use the captured session for direct HTTPS; ChatGPT/Z.ai use their separate browser profiles to submit messages and capture network responses. Your usual browser profile is not read or changed.

Saved sessions are reused and the configured service starts with Gravity. Use **Sign in again** when a session expires. Setup checks readiness without generating a response; only a successful **Test response** verifies generation at that time. Website model availability, quotas, and security checks still apply. The aliases identify website routes, not access to a specific restricted model version.

If setup fails, follow the recovery action beside the error. **Connection details & diagnostics → Copy diagnostics** records stages and error codes without account credentials or chat content. Preparing another account preserves existing connections where possible; service reload waits for active requests. Do not delete your saved profile to retry a sign-in check.

### ChatGPT keeps asking for verification

After you close the separate sign-in browser, Gravity opens the saved session to check it. If that **verification browser** shows a security check, complete it yourself and **keep that browser open**. Gravity waits on the same page for up to two minutes and continues automatically when it becomes ready.

If the check keeps repeating, use **Use your normal Chrome tab** when the recovery screen appears and follow Browser Connector setup below. To stop the wait earlier, click **Cancel setup**, then open **Settings → Browser Connector**. Keep a new, empty ChatGPT tab open in your normal Chrome profile. Gravity retains the saved dedicated sign-in. Website security checks can still recur; changing the app's sandbox is not a supported remedy.

With Browser Connector, Gravity opens an owned task tab for the request. If that tab shows a security check, it is brought forward once. Complete the check yourself and keep that tab open; Gravity waits on the same page for up to two minutes before submitting the prompt. If the wait expires before submission, the task tab is retained for a later explicit retry. Gravity rechecks its website, history and draft before use. Cancellation or a service-worker restart does not replay the request. Website response tests allow up to three minutes, while ordinary API tests retain their shorter allowance.

## Optional Browser Connector extension

For Claude, ChatGPT, DeepSeek, Qwen, Z.ai, and Gemini, open **Settings → Browser Connector** and follow the [Chrome quick start](BROWSER-CONNECTOR.md#one-time-chrome-setup). The connector starts automatically and creates the **Browser Connector** provider and all six website routes. Older profiles may retain its name **Connected Chrome**. **Open extension setup** prepares the bundled extension and opens Chrome's extensions page. Install it once with **Developer mode → Load unpacked**, click **Connect** in its popup, and approve the matching request in the desktop.

Keep a signed-in tab open for each service in the Chrome profile containing the extension. Choose its browser model in a conversation and send a simple test message. No separate Python environment, Git checkout, configuration file, or cookie export is needed for this method. Approved pairing is saved with Windows encryption and reused after normal app or connector restarts; website sessions stay in Chrome.

These routes select websites. Choose the actual model through the website's own controls. The adapters are experimental and tested with synthetic local pages; detecting a tab or passing a fixture test does not establish live account compatibility. See [supported routes, privacy, and troubleshooting](BROWSER-CONNECTOR.md). The following provider setup is for direct APIs and separately prepared API bridges; browser setup already creates its provider.

## Configure model providers

Open **Settings → Models & providers**. Save the connection before using **Discover models** or **Test model**. Discovery adds model IDs to the draft; select **Save provider** again to keep them.

| Service | API protocol | Example base URL |
| --- | --- | --- |
| Any OpenAI-compatible service | OpenAI compatible | `https://your-service.example/custom-prefix/v1` |
| OpenAI API | OpenAI compatible | `https://api.openai.com/v1` |
| Ollama with its API running | OpenAI compatible | `http://127.0.0.1:11434/v1` |
| LM Studio with its local server enabled | OpenAI compatible | `http://127.0.0.1:1234/v1` |
| Gemini web2api | OpenAI compatible | `http://127.0.0.1:8081/v1` |
| Anthropic API | Anthropic Messages | `https://api.anthropic.com/v1` |
| Google Gemini API | Google Gemini | `https://generativelanguage.googleapis.com/v1beta` |

These URLs are editable presets, not evidence that a service is running or a model is installed. Use the endpoint and model identifiers documented by your own service.

The app appends paths such as `/chat/completions`, `/messages`, or `/models`. OpenAI-compatible base URLs retain their custom path; `/v1` is not inserted automatically. Nonsecret query parameters such as `api-version` are preserved. Base URLs must use HTTP(S), without embedded username/password, secret query parameters, or fragments. Use API-key and advanced-header fields for authentication. Advanced headers are a JSON object with string values; connection-management headers and cookies are not supported there. Services without a model-discovery route can still use manually entered model IDs.

Enter custom model IDs one per line or separated by commas, and enter one as the default. An ID does not have to appear in discovery to be saved. The upstream service must recognize it and support the requested capabilities. Native Anthropic/Gemini requests are translated by the adapter; tool availability and model behavior still depend on the upstream.

Provider keys and advanced-header values are encrypted in desktop state. Existing keys are masked and retained when the key field is blank. Select **Remove the stored key on save** to clear a key. Masked advanced-header values remain unchanged until replaced or removed.

**Test model** sends a short, fixed message to the saved default model and requires a nonempty text response. It does not send conversation history, project files, or tool definitions. It can use provider quota and, for browser models, appear in website history. Discovery remains separate and is not required for testing a manually entered model. Browser tests first check that the connector is running, the extension is paired, and the selected website tab is detected and available. A successful test verifies a text response at that time; test project tools separately with a model that supports tool calls.

The Get started page separates bundled website setup, the Browser Connector extension, and API-key setup. Models & providers initially selects the provider used by the current conversation. Testing or saving another provider does not select it for that conversation. Choose **Use in this chat** to apply the saved default model, or select a specific model from the chat's model menu. The chat shows the selected provider and model above its composer.

## Attach files to a chat

1. Open a new or existing chat and click the **+** beside the model selector.
2. Choose your files in the Windows file picker, then click **Open**. Hold Ctrl to select more than one.
3. Check the file chips above the message box. Click a chip's **×** to remove it. Cancelling the picker keeps your current draft and attachments.
4. Type what you want Gravity to do with the files, then press **Enter** or **Send**. You can also send a file without typing a message.

UTF-8 text/code and PDF, DOCX, XLSX and PPTX documents are supported in every chat, without opening a project. Gravity extracts document text locally and sends that text as message context. Document images, visual layout and macros are not sent as native document input. Spreadsheet formulas are not calculated; the reader uses stored values/cached formula results.

| Input | Limit |
| --- | --- |
| Combined text/code/documents/project excerpts | Four files or excerpts; 60,000 characters total |
| Picked UTF-8 text/code | 40 KiB and 500 lines per file |
| PDF/Office document | 10 MiB per file; extracted output must fit the combined character limit |
| PDF | 50 pages; selectable text required |
| PowerPoint | 50 slides |
| Excel | 20 sheets, 2,000 rows and 10,000 cells |
| PNG/JPEG/WebP/GIF images | Image-capable connection required; eight images, 8 MiB each and 24 MiB combined encoded data |

The reader runs in a separate process with a deadline and bounded input, XML and Office archive expansion. It rejects protected, damaged, macro-containing or oversized files with a specific message rather than silently truncating them. Legacy DOC/XLS/PPT and macro formats need a modern, macro-free **Save As** copy. General ZIP uploads are unsupported. Scanned or image-only PDFs need an OCR text copy, or page images sent to an image-capable connection.

While a document is being read, the composer shows **Reading…** with a **Cancel** button. Cancelling, switching drafts or closing the app stops owned reading work. Previous accepted attachments remain available after cancellation, and a delayed result cannot attach to a different draft.

Files provide read-only message context and their text is saved in chat history and backups. They do not give the agent permission to edit their original folder. If a text file changes after selection, remove it and attach it again before sending. To edit project files, use **Open folder**, choose **Build**, and select the appropriate permissions.

## Projects, agents, and changes

Open a local folder to add a project. Removing a project from the sidebar removes its reference and does not delete the folder. Conversations are saved automatically. Separate conversations can run concurrently; stopping one does not stop the others.

New chats use **Chat** mode for ordinary questions without project tools. **Plan** exposes file inspection and artifact creation. **Build** also permits the model to request file writes and shell commands. The permission selector below the composer controls approval: **Ask for approval** asks for writes and commands, **Approve file edits** automatically applies project file edits but asks for commands, and **Full access** automatically runs both. Full access requires a confirmation before activation. Each conversation keeps its own choice; a new blank conversation starts with Ask for approval. Stop a running agent before changing its permissions. See [permissions](PERMISSIONS.md).

Plan mode remains read-only at every permission level. A rejected action is returned to the model as rejected. Existing files must be read before replacement, and the write is rejected if the file has changed since the proposal was prepared. Automatic approvals are labelled in the conversation and do not bypass backups, stale-content checks, or file-tool boundaries.

The Files panel opens UTF-8 text in Monaco, supports new files and saving, and searches literal file contents. The Changes panel displays Git status and staged/unstaged diffs. Git commit, push, and branch mutations are not automated by that panel. The Terminal panel runs individual commands; it does not preserve an interactive shell session or support prompts requiring interactive input. Commands have time/output limits and a stop control. Manual editor saves and manual Terminal runs are direct user actions, separate from agent permission modes.

File tools are bounded to the selected project, reject traversal and symlink/junction redirects, and use a 2 MiB text-file limit. Search excludes common generated/dependency directories and internal backups. These file-tool restrictions do not sandbox shell commands: a command you approve runs with your OS permissions.

## Start a Gemini web2api bridge

For existing Chrome logins across all six websites, use the [browser connector](BROWSER-CONNECTOR.md). For custom API backends or the headless universal service, see [Universal Web2API connections](UNIVERSAL-WEB2API.md). **Settings → Web2API Bridges** also supports external and managed process profiles. The existing Gemini launcher is available on that page.

The integration targets [ikhsan3adi/gemini-web2api](https://github.com/ikhsan3adi/gemini-web2api). The inspected source revision is recorded in [reverse-engineering.md](reverse-engineering.md). Its `go.mod` requires Go 1.26.5 if you build that revision from source; a separate Windows executable can also be used.

1. Obtain or build the bridge executable following its upstream instructions.
2. Prepare your own Gemini session cookie file and bridge JSON configuration using the upstream setup instructions. `gemini.config.example.json` in this project is a starting configuration for managed launch; it contains no working session credentials. Keep these files outside source control.
3. Set `cookie_file` in your configuration. Relative paths are resolved against that configuration's directory. If omitted, the app uses `cookie.txt` in the same directory.
4. Open **Settings → Web2API Bridges**, select the executable and configuration, and choose an unused port such as `8081`.
5. Select **Save & start bridge**. The app creates a temporary launch configuration bound to `127.0.0.1`, generates an API token, disables request logging, and starts the selected executable. It updates the **Gemini Web2API** provider when the health endpoint responds.
6. Open **Models & providers**, discover the bridge's model IDs, save them, and send a chat message to check actual generation.

The original configuration and cookie file remain in place. The app does not read the cookie contents into the renderer. It stops only the process it started. If the port is occupied, either choose a different port or configure a normal provider for the already running bridge instead of trying to launch another instance.

The bridge uses a changing private web protocol. Expired sessions, upstream throttling, model entitlements, or protocol changes can prevent inference even when process health and model listing work. The inspected bridge returns a static model registry, can fall back for unknown names, and emulates tool calls from prompted output. Tool-call responses may be buffered into one SSE event. These behaviors are properties of the upstream bridge.

## Automatic startup and text size

Browser Connector and the API start when Gravity opens by default. Saved custom bridge profiles are started or checked automatically, and a Gemini bridge starts when its executable and configuration have been selected. The startup controls on each settings page let you disable this. Startup failures remain on the relevant service card and do not block the other services or the desktop.

Open **Settings → Appearance** for Standard (100%), Comfortable (110%, default), or Large (125%) text and interface sizes. Your selection is saved automatically.

## Use the desktop's API gateway

Gravity's local API starts with the app by default. In **Settings → API**, copy its URL and access token into your client. The default base URL is `http://127.0.0.1:4318/v1`; a custom port and token are available in advanced settings. Stop the gateway before changing either. The startup toggle applies when Gravity opens; it is not a Windows background service. Existing explicit startup preferences are retained.

The gateway token is distinct from your provider API keys. Native API clients use it as an OpenAI-style bearer token. The gateway routes requests to configured providers but does not run the desktop agent loop or execute returned tool calls. Client applications own their own tool-execution loop.

PowerShell example (replace the token placeholder with the value from Settings):

```powershell
$env:STUDIO_GATEWAY_TOKEN = 'PASTE_THE_GATEWAY_TOKEN'
$studioHeaders = @{ Authorization = "Bearer $env:STUDIO_GATEWAY_TOKEN" }
$studioModels = Invoke-RestMethod -Uri 'http://127.0.0.1:4318/v1/models' -Headers $studioHeaders
$studioModels.data | Select-Object id, owned_by
```

Choose an exact `id` from that listing, then make a request:

```powershell
$studioBody = @{
  model = 'provider-id/model-id'
  messages = @(@{ role = 'user'; content = 'Reply with a short greeting.' })
  stream = $false
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Uri 'http://127.0.0.1:4318/v1/chat/completions' -Method Post -Headers $studioHeaders -ContentType 'application/json' -Body $studioBody
```

For SSE, create `chat-request.json` with your selected model ID:

```json
{
  "model": "provider-id/model-id",
  "messages": [{ "role": "user", "content": "Reply with a short greeting." }],
  "stream": true
}
```

Then run:

```powershell
curl.exe --no-buffer 'http://127.0.0.1:4318/v1/chat/completions' -H "Authorization: Bearer $env:STUDIO_GATEWAY_TOKEN" -H 'Content-Type: application/json' --data-binary '@chat-request.json'
```

Streaming responses use `data:` SSE events and end with `data: [DONE]`. JSON responses follow the OpenAI chat-completion shape. To use a custom model absent from the saved model list, supply the gateway's `provider_id` extension:

```json
{
  "provider_id": "your-provider-id",
  "model": "your-custom-model-id",
  "messages": [{ "role": "user", "content": "Hello" }]
}
```

The provider ID is the prefix in that provider's listed model IDs. When using a saved arbitrary model ID without a provider prefix, the gateway selects the first configured provider listing it. Namespaced IDs remove that ambiguity.

Supported gateway routes are `GET /health`, `GET /v1/models`, and `POST /v1/chat/completions`. `/health` is unauthenticated and confirms only that this gateway is listening. Browser cross-origin requests are rejected, and the server listens only on IPv4 loopback. `/v1/responses`, embeddings, image-generation, and Google-native routes are not exposed by this gateway. The separate Gemini bridge has its own broader route set.

## Run only the gateway

The standalone gateway uses an explicit JSON configuration and environment variables. It does not read or decrypt desktop settings and does not start Gemini web2api for you.

Copy `gateway.config.example.json` to your own configuration, set provider IDs/base URLs/models, and put the name of each key environment variable in `apiKeyEnv`. Then:

```powershell
$env:GATEWAY_TOKEN = 'SET_A_RANDOM_TOKEN_OF_AT_LEAST_16_CHARACTERS'
$env:GEMINI_BRIDGE_API_KEY = 'YOUR_RUNNING_BRIDGE_API_KEY'
npm run gateway -- --config gateway.config.json
```

An unauthenticated local provider can omit `apiKeyEnv`. Keep tokens out of committed files. Stop with Ctrl+C. Do not run the standalone and desktop gateways on the same port.

## Local data and recovery

New profiles use `%APPDATA%\Gravity\state.json`. An existing Antigravity Studio profile remains at `%APPDATA%\Antigravity Studio\state.json` so saved credentials and extension locations continue to work. It contains project references, conversation content, settings, the gateway token, and encrypted provider secrets. Treat this directory as private local data. Provider encryption is tied to the operating-system user; copying this file to another machine is not a credential migration mechanism.

Bundled website sessions live in `web2api` inside that active user-data directory, so moving only the executable on the same computer keeps setup available. The private bridge configuration contains the generated local key and any captured DeepSeek/Qwen session tokens; do not treat it as an encrypted export. ChatGPT/Z.ai retain their dedicated browser profiles.

Gravity recognizes earlier companion data and migrates it only after the separate browsers and service release it. It retains the original for rollback. For a pending or failed migration, close those browsers, stop any externally launched bridge, and choose **Settings → Appearance → Migrate saved website data**. Keep the old companion folder until this succeeds. Gravity does not terminate an externally owned service automatically.

**Settings → Appearance → Export backup** saves conversations and nonsecret API settings. **Import backup** restores them with Ask permissions. Backups do not transfer website sessions, API credentials, bridge launch settings, or prior executable approvals. Sign in or enter credentials again on another Windows account or computer.

Browser extension setup copies the bundled files into `browser-extension\current` inside the active profile directory and updates recognized older versioned folders in place. The generated browser provider key is encrypted like other provider keys and rotates when the connector starts. The separate approved extension pairing token is encrypted in desktop state and retained by Chrome's extension, allowing reconnection after a normal restart. Revoke access in Browser Connector settings to remove that saved approval. Website logins remain in Chrome and are not copied into desktop state.

While a managed bridge is running, `bridge-runtime.json` in the active profile directory contains its temporary bearer token and copied launch settings. A plaintext launch file is required by the external bridge executable. The app removes it on managed stop; an abnormal process or machine termination may leave it behind. Keep user-data directories out of shared folders and source control. Cookie and source configuration files stay at the paths you selected.

File replacements create backups in each project's `.antigravity/backups/`. Each backup JSON records the original relative path and contents. Restore deliberately after comparing with current files. Add `.antigravity/` to a project's `.gitignore` when appropriate; the app does not modify that project's ignore rules automatically.

For an isolated development profile, set `GRAVITY_DATA_DIR` (or the legacy `ANTIGRAVITY_DATA_DIR`) to a separate absolute directory before launching. The app does not overwrite malformed state files during startup; correct or move the damaged file after preserving a copy.

## Troubleshooting and verification

| Symptom | Check |
| --- | --- |
| Cannot reach provider | Service process, base URL/API prefix, port, and network connectivity |
| HTTP 401/403 | Correct provider key for that endpoint; gateway clients need the gateway token |
| Unknown model | Exact upstream ID, saved provider model list, and namespaced gateway ID |
| Discovery works but chat fails | Real account entitlement, generation credentials, quota, and tool support |
| Chrome connector has no detected tab | Sign in in the same Chrome profile as the extension, keep the service tab open, and refresh the extension status; see [browser troubleshooting](BROWSER-CONNECTOR.md#troubleshooting) |
| Chrome pairing was revoked or extension data was cleared | Start the connector, click Connect in its extension popup, and approve the matching request again |
| Bridge startup fails | Executable/config paths, cookie-file location, available port, and Process output |
| File changed since read | Reload current file and prepare a fresh edit; do not overwrite newer work |
| Text file will not open | UTF-8 encoding, file size, and whether the path redirects outside the project |
| Electron runtime missing after install | Check whether the package manager blocked Electron's install script, then reinstall/rebuild the dependency |

Run `npm test` for automated checks and `npm run build` for TypeScript and production-bundle validation. Tests use temporary workspaces and local HTTP fixtures. Live inference with your chosen provider remains an end-to-end setup check requiring your actual service credentials. See [reverse-engineering.md](reverse-engineering.md) for feature scope and remaining parity limits.
