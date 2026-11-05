# Gravity standalone Web2API

An OpenAI Chat Completions service for **DeepSeek, Qwen, ChatGPT, and Z.ai**, alongside the existing separate Gemini/Claude adapters. Default API: **http://127.0.0.1:4320/v1**. Gravity 1.7.0 bundles this service and its runtime; it can also run independently. Neither route needs the Browser Connector extension.

## Recommended: connect inside Gravity

1. Open **Gravity-1.7.0-x64.exe**, then **Settings → Get started** or **Web2API Bridges**.
2. Choose a website and click **Connect & start**. Choose installed Chrome or Edge under **Browser for the next sign-in** if needed.
3. Sign in in the separate browser, complete the website's checks, and open a **new, empty chat**. **Close all windows of that separate browser**. Gravity checks the saved profile and continues automatically for all four websites.
4. Click **Test response** when the service is ready, then **Use in this chat** if needed.

No pasted token, configuration file, terminal, or companion folder is required. Gravity saves the connection, discovers its models, and starts the service on later launches. **Sign in again** repairs an expired session. Setup sends no chat prompt; **Test response** sends a short message and may use quota. A ready service is not proof of a successful account response.

Desktop sessions live in the permanent Gravity user-data folder. Older companion data is migrated when its browsers and service are closed; retain the old folder until migration succeeds. See [Windows setup and recovery](WINDOWS.md). The remaining instructions describe advanced standalone operation.

## Website routes

| Website | Transport | Setup | Public aliases |
| --- | --- | --- | --- |
| DeepSeek | Direct HTTPS | Sign in once to capture the dedicated profile's session; advanced token configuration also supported | `deepseek-web`; `deepseek-web-thinking` only when advertised by account discovery |
| Qwen | Direct HTTPS | Sign in once to capture the dedicated profile's session; advanced token configuration also supported | `qwen-web`, using an account-advertised text model |
| ChatGPT | Normal website submission in a dedicated Chrome/Edge profile; network SSE capture | Prepare profile once; complete checks required by the website | `chatgpt-web`, the selected website model |
| Z.ai | Normal website submission in a dedicated Chrome/Edge profile; network SSE capture | Prepare profile once; complete checks required by the website | `zai-web`, the selected website model |

Saved setup is reused on restart. There is no paid model API key requirement. Website sessions, quotas, and model availability still apply; refresh expired sessions when required. Guest access works only if the website permits it. The bridge never opens or extracts credentials from your normal browser profile.

## Advanced: install from source

A separately prepared `Gravity-Web2API` companion folder includes Node and double-click launchers. Follow [Windows standalone setup](WINDOWS.md#advanced-run-the-companion-service-separately) for that package; the commands below are for the source checkout. Do not start this standalone service on a port already used by Gravity's bundled service.

Use Node 22.13 or newer. Install Chrome or Edge for browser setup/submission; no browser download is required. From the source checkout:

```powershell
cd E:\application\Antigravity\Gravity\bridges\multi-web2api
npm ci --cache E:\application\Antigravity\.npm-cache
npm run setup
```

Setup creates ignored `.data/config.json`, with a generated **local API token**, default port 4320, browser channel `chrome`, and disabled providers. The local token protects this service; it is separate from website credentials. Keep it as generated. Setup sends no website prompts.

### Sign in once

Run the login command for each website you want:

```powershell
npm run login -- deepseek
npm run login -- qwen
npm run login -- chatgpt
npm run login -- zai
```

On Windows, all four commands open normal installed Chrome/Edge in a dedicated bridge profile without automation or debugging flags. Sign in yourself, complete any security checks, and open a new empty chat. **Close all windows of that separate browser, then press Enter in the terminal.** The helper briefly reopens the same profile with the sandbox enabled to verify it without submitting a prompt. DeepSeek/Qwen capture a token from that profile and check authentication; ChatGPT/Z.ai check a fresh message box and keep cookies in the profile. Google and the websites still decide whether to accept sign-in.

On other platforms, complete setup in the helper browser before pressing Enter. Profiles live in `.data/browsers/<website>` and remain after setup closes. For Edge, add `--browser msedge`, for example `npm run login -- qwen --browser msedge`. The selected browser is remembered for that site. Close any other bridge/setup process using that profile before signing in again.

### Optional direct token configuration

DeepSeek/Qwen can also run without browser capture. Edit the relevant entries under `providers` in `.data/config.json`:

```json
"deepseek": { "enabled": true, "token": "YOUR_WEBSITE_SESSION_TOKEN" },
"qwen": { "enabled": true, "token": "YOUR_WEBSITE_SESSION_TOKEN" }
```

Alternatively supply `GRAVITY_DEEPSEEK_TOKEN` or `GRAVITY_QWEN_TOKEN` in the bridge process environment. This enables the provider without writing the environment token to disk. Use only your own session tokens. They are distinct from the generated local API key. Login helper updates merge only the selected provider into saved configuration.

## Start, discover, and test

```powershell
npm start
```

In another terminal in the same directory:

```powershell
npm run info
npm run status
npm run models
```

`info` shows the generated local API key and exact Gravity managed launch fields. `status` checks local readiness, and `models` lists configured aliases. Neither sends an inference prompt. DeepSeek/Qwen model discovery runs at startup and before generation. Restart after changing configuration. Qwen selects the first available account text model; optionally set its provider `upstreamModel` to an actual advertised website model ID. DeepSeek uses website `default` and gates thinking on advertised capability. Browser aliases refer to the website's selected model; inventing a model ID cannot unlock it.

Generation verification is explicit and consumes website quota:

```powershell
npm run probe -- qwen-web
npm run probe -- chatgpt-web
```

This sends one short “Reply with only OK.” request. Configure the account/profile first. **`npm test` runs automated fixtures; it is separate from account probing.** No live-account inference was verified during implementation.

All commands accept `--data-dir <path>`; use the same path throughout. The default `.data/` directory is ignored by Git. Keep custom session directories private and out of source control. Change `port` in private config if 4320 is occupied; the bridge does not stop another service.

## Advanced: connect a standalone service to Gravity

Use these steps for a separately running service. The beginner **Connect & start** flow configures its own service automatically and does not require these fields.

1. Start the bridge and run `npm run info`.
2. In **Settings → Models & providers → Add provider**, choose the **Gravity Web2API** preset and paste the generated local API key. In older Gravity versions, choose **OpenAI compatible** and enter `http://127.0.0.1:4320/v1` manually.
3. Discover models, save, and select this provider and a returned alias in your chat. Gravity's **Test model** button performs real, quota-consuming inference.
4. For automatic startup, first stop the terminal service with Ctrl+C. Open **Settings → Web2API Bridges → Advanced adapter profiles & configuration → Add bridge**, link that provider, choose **Managed**, and copy the executable, arguments JSON, working directory, and health URL from `npm run info`. Choose **Save & start bridge**, then enable **Start saved bridge profiles when Gravity opens**. Gravity launches the foreground Node service.

`npm run info -- --json` prints ready-to-copy provider/profile JSON. It does not import settings; select the saved provider in the managed profile. Older desktop executables can connect to this separately installed service.

Keep the three connection types separate:

- **Browser Connector:** Gravity's extension paired with an existing browser; a separate optional route.
- **Web2API Bridges:** this standalone service or Gemini/Claude adapters, started externally or managed by Gravity.
- **Normal APIs:** ordinary OpenAI-compatible, Anthropic, Gemini, or local model endpoints and their usual credentials.

Gravity already accepts arbitrary model IDs from OpenAI-compatible APIs. Its [universal gateway](../../docs/UNIVERSAL-WEB2API.md) can expose this bridge alongside Gemini, Claude, and other saved providers. Each new *website* requires its own protocol adapter; there is no universal website request format.

## API contract and safeguards

`GET /health` returns minimal public local health. `GET /status`, `GET /v1/models`, and `POST /v1/chat/completions` require `Authorization: Bearer <local-token>`. The service checks loopback binding/remote address/Host, rejects browser Origin/Cookie requests, bounds headers/connections and JSON bodies to 512 KiB, and returns fixed safe upstream errors. Do not expose it through a public proxy.

Messages are text only. Images, files, attachments, native website tools, and Responses API endpoints are unsupported. Formatted input is limited to 120,000 characters, final output to 200,000 characters, and upstream network bodies to 8 MiB. One completion per provider is allowed; other providers may run concurrently. Busy providers return 409. Client disconnects/timeouts cancel downstream work; submissions are not automatically retried.

OpenAI SSE output is buffered until the whole website response passes completion/tool validation, identified by `X-Web2API-Stream-Mode: buffered`. Malformed/incomplete replies fail instead of producing a successful partial answer. Token usage is omitted or null because authoritative website token counts are unavailable.

Positive integer `max_tokens` / `max_completion_tokens` are accepted as compatibility hints, including Gravity's model test. They do not enforce a website token cap; `X-Web2API-Generation-Controls: website-defaults` identifies this. Other unsupported generation controls return 400.

Function tools are prompt-emulated. Only entire response envelopes emit declared names with bounded JSON object arguments and matching tool choice. Narrative/code examples stay final text. Strict JSON Schema mode is rejected; full argument-schema compliance is requested in the prompt but not enforced. **The bridge never executes tools, commands, or file changes.** The caller performs its own validation and approvals.

Config replacements are atomic and helper updates serialized, with bounded Windows sharing retries. If a crashed helper leaves `.data/config.lock`, close setup terminals before removing it. POSIX private modes are used where supported; Windows follows directory ACLs. Linked/junction profile paths and restored website history/drafts are rejected.

The private bridge configuration stores the local API key and captured DeepSeek/Qwen session tokens as readable JSON. It is not encrypted. Protect the data directory, including browser profiles, and never commit or share it. Desktop provider-key encryption and nonsecret backup export do not encrypt or transfer this bridge's session directory.

Run `npm test` here or at the repository root. Tests cover security, cancellation/concurrency, prompt/tool/config races, direct mocked website protocols, the actual pinned DeepSeek WASM against an independent fixture, and installed Chrome/Edge UI submissions to intercepted network responses. Browser fixtures make no live website calls. Live compatibility requires an explicit account probe. Protocol references, pinned commits, and license notices are in [THIRD_PARTY.md](THIRD_PARTY.md) and [adapters/vendor/](adapters/vendor/).
