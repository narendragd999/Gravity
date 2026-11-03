# Setup and operation

## Run the desktop

From `E:\application\Antigravity\antigravity-desktop`, install dependencies with `npm install`, build with `npm run build`, and launch with `npm start`. Node.js 24 with npm is recommended; the implementation was tested with Node 24.22.1 on Windows. Git must be on PATH for the Changes panel. The editor, chat UI, and direct file operations work without Git.

`npm run dev` starts Vite on `127.0.0.1:5173` and then opens Electron. `npm run dist` builds a Windows x64 portable executable into `release/`. `npm run pack` creates an unpacked desktop distribution from the existing build. Run `npm run build` before `npm run pack`.

A packaged executable supplies its own Electron runtime. It still needs your selected model service and credentials. The optional process-based Gemini bridge needs a separate executable and session configuration; the included browser connector uses your existing Chrome profile instead.

## Connect signed-in Chrome accounts

For Claude, ChatGPT, DeepSeek, Qwen, Z.ai, and Gemini, open **Settings → Web2API bridges → Browser connector** and follow the [Chrome quick start](BROWSER-CONNECTOR.md#one-time-chrome-setup). **Start browser connector** creates the **Connected Chrome** provider and all six model routes. **Open extension setup** prepares the bundled extension and opens Chrome's extensions page. Install it once with **Developer mode → Load unpacked**, click **Connect** in its popup, and approve the matching request in the desktop.

Keep a signed-in tab open for each service in the Chrome profile containing the extension. Choose its **Connected Chrome** model in a conversation and send a simple test message. No separate Python environment, Git checkout, configuration file, or cookie export is needed for this method. Restarting the connector requires pairing again; website sessions stay in Chrome.

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

Settings initially selects the provider used by the current conversation. Testing or saving another provider does not select it for that conversation. Choose **Use in this chat** to apply the saved default model, or select a specific model from the chat's model menu. The chat shows the selected provider and model above its composer.

## Projects, agents, and changes

Open a local folder to add a project. Removing a project from the sidebar removes its reference and does not delete the folder. Conversations are saved automatically. Separate conversations can run concurrently; stopping one does not stop the others.

**Plan** exposes file inspection and artifact creation. **Build** also permits the model to request file writes and shell commands. The permission selector below the composer controls approval: **Ask for approval** asks for writes and commands, **Approve file edits** automatically applies project file edits but asks for commands, and **Full access** automatically runs both. Full access requires a confirmation before activation. Each conversation keeps its own choice; a new blank conversation starts with Ask for approval. Stop a running agent before changing its permissions. See [permissions](PERMISSIONS.md).

Plan mode remains read-only at every permission level. A rejected action is returned to the model as rejected. Existing files must be read before replacement, and the write is rejected if the file has changed since the proposal was prepared. Automatic approvals are labelled in the conversation and do not bypass backups, stale-content checks, or file-tool boundaries.

The Files panel opens UTF-8 text in Monaco, supports new files and saving, and searches literal file contents. The Changes panel displays Git status and staged/unstaged diffs. Git commit, push, and branch mutations are not automated by that panel. The Terminal panel runs individual commands; it does not preserve an interactive shell session or support prompts requiring interactive input. Commands have time/output limits and a stop control. Manual editor saves and manual Terminal runs are direct user actions, separate from agent permission modes.

File tools are bounded to the selected project, reject traversal and symlink/junction redirects, and use a 2 MiB text-file limit. Search excludes common generated/dependency directories and internal backups. These file-tool restrictions do not sandbox shell commands: a command you approve runs with your OS permissions.

## Start a Gemini web2api bridge

For existing Chrome logins across all six websites, use the [browser connector](BROWSER-CONNECTOR.md). For custom API backends or the headless universal service, see [Universal Web2API connections](UNIVERSAL-WEB2API.md). **Settings → Web2API bridges** also supports external and managed process profiles. The existing Gemini launcher is the **Gemini · built in** choice on that page.

The integration targets [ikhsan3adi/gemini-web2api](https://github.com/ikhsan3adi/gemini-web2api). The inspected source revision is recorded in [reverse-engineering.md](reverse-engineering.md). Its `go.mod` requires Go 1.26.5 if you build that revision from source; a separate Windows executable can also be used.

1. Obtain or build the bridge executable following its upstream instructions.
2. Prepare your own Gemini session cookie file and bridge JSON configuration using the upstream setup instructions. `gemini.config.example.json` in this project is a starting configuration for managed launch; it contains no working session credentials. Keep these files outside source control.
3. Set `cookie_file` in your configuration. Relative paths are resolved against that configuration's directory. If omitted, the app uses `cookie.txt` in the same directory.
4. Open **Settings → Web2API bridges → Gemini · built in**, select the executable and configuration, and choose an unused port such as `8081`.
5. Select **Save & start bridge**. The app creates a temporary launch configuration bound to `127.0.0.1`, generates an API token, disables request logging, and starts the selected executable. It updates the **Gemini Web2API** provider when the health endpoint responds.
6. Open **Models & providers**, discover the bridge's model IDs, save them, and send a chat message to check actual generation.

The original configuration and cookie file remain in place. The app does not read the cookie contents into the renderer. It stops only the process it started. If the port is occupied, either choose a different port or configure a normal provider for the already running bridge instead of trying to launch another instance.

The bridge uses a changing private web protocol. Expired sessions, upstream throttling, model entitlements, or protocol changes can prevent inference even when process health and model listing work. The inspected bridge returns a static model registry, can fall back for unknown names, and emulates tool calls from prompted output. Tool-call responses may be buffered into one SSE event. These behaviors are properties of the upstream bridge.

## Use the desktop's API gateway

In **Settings → API gateway**, select a port different from the bridge port, copy the generated gateway access token, and select **Save & start gateway**. Default base URL: `http://127.0.0.1:4318/v1`. Stop the gateway before changing its port or token. Optional autostart applies when this desktop app opens; it is not a Windows background service.

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

Desktop data defaults to `%APPDATA%\Antigravity Studio\state.json`. It contains project references, conversation content, settings, the gateway token, and encrypted provider secrets. Treat this directory as private local data. Provider encryption is tied to the operating-system user; copying this file to another machine is not a credential migration mechanism.

Browser extension setup copies the bundled files into `%APPDATA%\Antigravity Studio\browser-extension\<app-version>`. The generated **Connected Chrome** provider key is encrypted like other provider keys and rotates when the connector starts. The separate extension pairing token is stored by Chrome's extension and held only in memory by the desktop; stopping or restarting the connector invalidates it. Website logins remain in Chrome and are not copied into desktop state.

While a managed bridge is running, `%APPDATA%\Antigravity Studio\bridge-runtime.json` contains its temporary bearer token and copied launch settings. A plaintext launch file is required by the external bridge executable. The app removes it on managed stop; an abnormal process or machine termination may leave it behind. Keep user-data directories out of shared folders and source control. Cookie and source configuration files stay at the paths you selected.

File replacements create backups in each project's `.antigravity/backups/`. Each backup JSON records the original relative path and contents. Restore deliberately after comparing with current files. Add `.antigravity/` to a project's `.gitignore` when appropriate; the app does not modify that project's ignore rules automatically.

For an isolated development profile, set `ANTIGRAVITY_DATA_DIR` to a separate absolute directory before launching. The app does not overwrite malformed state files during startup; correct or move the damaged file after preserving a copy.

## Troubleshooting and verification

| Symptom | Check |
| --- | --- |
| Cannot reach provider | Service process, base URL/API prefix, port, and network connectivity |
| HTTP 401/403 | Correct provider key for that endpoint; gateway clients need the gateway token |
| Unknown model | Exact upstream ID, saved provider model list, and namespaced gateway ID |
| Discovery works but chat fails | Real account entitlement, generation credentials, quota, and tool support |
| Chrome connector has no detected tab | Sign in in the same Chrome profile as the extension, keep the service tab open, and refresh the extension status; see [browser troubleshooting](BROWSER-CONNECTOR.md#troubleshooting) |
| Chrome pairing expired or was revoked | Start the connector, click Connect in its extension popup, and approve the matching request again |
| Bridge startup fails | Executable/config paths, cookie-file location, available port, and Process output |
| File changed since read | Reload current file and prepare a fresh edit; do not overwrite newer work |
| Text file will not open | UTF-8 encoding, file size, and whether the path redirects outside the project |
| Electron runtime missing after install | Check whether the package manager blocked Electron's install script, then reinstall/rebuild the dependency |

Run `npm test` for automated checks and `npm run build` for TypeScript and production-bundle validation. Tests use temporary workspaces and local HTTP fixtures. Live inference with your chosen provider remains an end-to-end setup check requiring your actual service credentials. See [reverse-engineering.md](reverse-engineering.md) for feature scope and remaining parity limits.
