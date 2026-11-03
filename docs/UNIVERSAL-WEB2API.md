# Universal Web2API connections

**Version 1.3.0 adds a simpler browser connection:** use your existing Chrome logins through the included companion extension. It provides adapters for all six requested websites without Python, Git, configuration files, or cookie exports. See [Browser connector](BROWSER-CONNECTOR.md) for the one-time Chrome installation, pairing, and compatibility limits. The process-based setup below remains available for independently installed API backends.

Antigravity Studio 1.2.0 can manage multiple bridge processes and expose their models through one local API. It supports OpenAI Chat Completions, Anthropic Messages, and Google Gemini API formats. A custom model ID is passed to its selected backend; the backend must actually support that model.

Each website still needs a separate adapter and its own session setup. The desktop does not turn a website URL into an API, install an adapter when you name a provider, or reuse a Gemini session for another service. The common bridge manager works with prepared HTTP backends; website-specific reverse engineering lives in those backends.

## Connect an already running bridge

1. Prepare and start the service's bridge using its reviewed setup instructions. Keep its session credentials in that bridge's own local configuration.
2. In **Settings → Models & providers → Add provider**, set its name, protocol, API base URL, and local API token when required. For an endpoint ending in `/v1/chat/completions`, select **OpenAI compatible** and enter the base ending in `/v1`. An adapter's `/v1/messages` endpoint uses **Anthropic Messages**.
3. **Save provider**, then **Discover models**. Select a default model and save again. Discovery checks the listing route; use **Test model** to verify a text response from the saved default model. A bridge without listing support can use manually entered model IDs.
4. In **Settings → Web2API bridges → Add bridge**, name a profile, choose **External · already running**, and select the provider you just saved.
5. Leave **Health URL** empty to check authenticated model discovery, or enter the bridge's documented health URL on the same origin. Select **Save & check connection**.

**Disconnect** stops tracking an external connection and leaves its process running. It never terminates a process found by name or port. Connection status reflects the most recent check; it is not continuous monitoring.

## Let the desktop start a prepared bridge

Create the provider and bridge profile as above, then choose **Managed · start from this app**. Enter:

- **Executable:** the absolute path to the prepared adapter binary or its Python/Node runtime.
- **Arguments JSON:** an array containing each argument separately, such as `["app.py"]` or `["dist/cli/index.js", "start"]`. Shell command strings and `.cmd`/`.bat` launchers are not accepted directly.
- **Working directory:** the adapter checkout or installation directory.
- **Environment variables JSON:** configuration documented by that adapter. Stored values use Windows-backed encryption and are masked after saving. Leave a mask unchanged to retain its value; removing a key deletes it.
- **Health URL:** the adapter's documented route, or leave blank for model discovery.
- **Startup timeout:** between 1 and 180 seconds.

**Save profile** only saves. **Save & start bridge** explicitly launches the configured process, waits for readiness, and shows status and output. **Cancel startup** remains available while readiness is pending. A failed start is reported and its owned process is stopped. Occupied ports are reported rather than reclaimed.

Use a foreground server command whose process stays alive. A launcher that daemonizes and exits cannot be reliably managed on Windows. Normal Stop terminates the owned process tree; closing the desktop also stops managed bridges. External bridges remain running. The child inherits the desktop environment plus the profile overrides; it is not an OS sandbox.

Managed profiles require a loopback provider URL, and custom health checks must share its origin. Configure the adapter itself to bind to loopback and enforce any needed API authentication: the desktop's client URL cannot change an adapter's listening address. Model API credentials are configured on the linked provider, separately from website-session credentials used by the bridge.

Stop or disconnect a bridge before editing its profile or provider connection. Model lists, default model, and provider name can still be saved after discovery while connected. A provider cannot be removed while bridge profiles reference it.

## Services requested for this project

The following are source-reviewed integration candidates. Addresses are their documented defaults, not evidence that they are installed or running on your computer. Detailed pinned sources, preparation requirements, licenses, and limitations are in [the research report](WEB2API-RESEARCH.md).

| Service | Bridge integration | Provider setup |
| --- | --- | --- |
| Gemini | Existing `ikhsan3adi/gemini-web2api`; keep using **Gemini · built in** | OpenAI compatible, `http://127.0.0.1:8081/v1` |
| Claude | `cyberanrhy/claude-web2api` was inspected, but needs corrections before adoption | Its API format is OpenAI compatible; default `http://127.0.0.1:8082/v1`, health `/health` |
| ChatGPT | Prepared `tang-vu/tab2api`, with manual login to its dedicated browser profile | `http://127.0.0.1:3210/v1`; OpenAI for text, its documented Anthropic compatibility route for tools |
| Qwen and DeepSeek | Prepared `mmmlllnnn/FreeTokenAPI`; one process can serve both | OpenAI compatible, `http://127.0.0.1:8000/v1`, health `/health` |
| Z.ai | Prepared `jubinjacob03/glm-proxy` with its required authentication/runtime setup | OpenAI compatible, `http://127.0.0.1:3007/v1`, health `/health` |
| Other sites or local models | Any prepared backend implementing one of the three supported API formats | Use its actual URL, authentication, and documented model IDs |

The supplied Claude repository has no local API-key validation, binds to all interfaces, logs prompts, and echoes the requested model without forwarding model selection upstream. It is therefore documented as a reference, not shipped or automatically installed as a working Claude adapter. No Claude, ChatGPT, Qwen, DeepSeek, or Z.ai web session was used to claim a successful live test for this release.

Prompt-based tool emulation is used by several web adapters. Successful text generation does not establish reliable agent actions. File edits and commands need structured tool calls and tool-result round trips. The conversation's approval policy remains in effect for every backend; Plan mode stays read-only.

## One API for multiple backends

The desktop's **API gateway** routes every configured provider through one authenticated base URL, normally `http://127.0.0.1:4318/v1`:

- `GET /v1/models` returns configured model IDs prefixed by provider ID.
- `POST /v1/chat/completions` accepts a listed `provider-id/model-id`, or an explicit `provider_id` with a custom model ID.

This selects the backend explicitly. It does not substitute another website or model when a route fails. A gateway completion returns model output and tool calls; the calling client owns tool execution. The desktop agent has its own execution loop and permissions.

## Run the universal service without the desktop

Use Node.js 24 and copy `universal-web2api.config.example.json` to a private configuration location. Configure your actual providers and optionally add prepared bridge profiles. Provider API keys use `apiKeyEnv`, secret headers use `headerEnv`, and bridge environment values can be supplied by `envFrom`. These refer to environment variable names instead of storing credentials in the JSON example.

Set `GATEWAY_TOKEN` to your own random token of at least 16 characters, then run:

```powershell
node electron/standalone.mjs --config C:\path\to\universal-web2api.json
```

Or, from a source checkout, use `npm run web2api -- --config C:\path\to\universal-web2api.json`. Existing `gateway.config.example.json` configurations remain supported. Relative working directories resolve against the configuration file; executable paths are absolute and arguments are passed without a shell.

Invoking the service starts the enabled configured bridges before exposing the gateway. A failed startup cleans up owned processes. Ctrl+C stops the gateway and owned bridges while leaving external services running. The headless service keeps resolved credentials in memory and does not write a desktop settings file. Process health, model discovery, and live inference are separate checks.
