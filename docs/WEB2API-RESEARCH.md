# Web-to-API bridge research

Inspected public repository metadata and source on **2026-11-02**. No bridge was installed or launched for this review, no account was logged in, no user credential file was read, and no live generation was verified. A source implementation or successful health response is not evidence that an account can currently generate with a particular model.

A common process manager can start an already prepared adapter and connect its HTTP endpoint to a provider. It cannot make arbitrary websites speak an API. Each website still needs its own maintained adapter, authorized session, supported request mapping and model behavior.

## Recommended catalog

“Candidate” means useful source to review and configure, not a verified working service. The linked commits freeze what was inspected.

| Website / scope | Candidate | Desktop provider and default address | Setup and account requirement | Important limitation / recommendation |
| --- | --- | --- | --- | --- |
| Claude.ai | [cyberanrhy/claude-web2api](https://github.com/cyberanrhy/claude-web2api/tree/3715e797523890899ddc9f5839073a6459aa5846) | OpenAI-compatible; `http://127.0.0.1:8082/v1` | Python 3.10+ per README, `curl_cffi`, required adjacent `config.json`, own Claude web cookies | **Reference only until fixed**: listener is hardcoded to all interfaces, no client auth, full prompts are logged, requested model is not sent upstream. Missing dependency manifest and license file. Details below. |
| ChatGPT.com | [tang-vu/tab2api](https://github.com/tang-vu/tab2api/tree/decba9acb419baae449b3eb026acd9002efa31f0) | OpenAI-compatible for text, or Anthropic protocol for its tool shim; `http://127.0.0.1:3210/v1` | Node >=22.13; Playwright Chromium; user manually logs into a dedicated browser profile; local Bearer token | Good candidate for a personal browser bridge. OpenAI route does **not** support tools; Anthropic route has a prompt-based tool translation. Incoming model names do not select the ChatGPT UI model. |
| DeepSeek + Qwen | [mmmlllnnn/FreeTokenAPI](https://github.com/mmmlllnnn/FreeTokenAPI/tree/a54a9bb5d32413dea819ab0a0bc37dfc352de928) | OpenAI-compatible; `http://127.0.0.1:8000/v1`; also Responses and Anthropic Messages | Python >=3.10; own `DEEPSEEK_TOKENS` and/or `QWEN_TOKENS` in local `.env`; DeepSeek additionally needs Node.js LTS | Useful two-provider candidate. No downstream API-key authentication; keep loopback. Tool calls are translated from model text. Model discovery and successful inference are separate checks. |
| Qwen, text/media alternative | [smanx/qwen2api](https://github.com/smanx/qwen2api/tree/54f7993cbcb4a2dd5ae7210759fbe574a4c09f7a) | OpenAI-compatible; `http://127.0.0.1:8765/v1` | Node >=18; optional `API_TOKENS`; browser/runtime prerequisites vary by deployment | No OpenAI tool calling. Source hardcodes `0.0.0.0`. Package declares ISC, but no license file was found. Prefer the loopback-capable FreeTokenAPI candidate for the desktop agent. |
| Z.ai | [jubinjacob03/glm-proxy](https://github.com/jubinjacob03/glm-proxy/tree/cc8165b675af2db10fb6ae85aa01cf33568c2e46) | OpenAI-compatible; `http://127.0.0.1:3007/v1`; also Anthropic Messages | Go 1.26.7 for source build; reviewed prepared binary; own Z.ai session for account models; separate local `AUTH_TOKEN`; browser/device-auth runtime dependencies | Experimental external adapter only. Tool mode is prompt emulation. Model listing has a static fallback. Source depends on additional device/challenge machinery; this app does not implement, provision or promise that mechanism. |
| Multiple providers | [xtekky/gpt4free / g4f](https://github.com/xtekky/gpt4free/tree/70a3d3263d07975adfd5000fa49af8d61af6c5c8) | OpenAI-compatible; configured loopback port; supports provider-specific routes | Python 3.10+ per README; provider-dependent browser/auth/runtime dependencies; optional local `G4F_API_KEY` | Broad framework, **not proof of universal website coverage**. GPL-3.0. Review selected adapter and outgoing destination. In particular its inspected Claude adapter sends cookies to a third-party worker by default; do not treat that as a local Claude integration. |

For all candidates, use a user-selected absolute executable, separate argument array, explicit working directory and loopback health URL. Store web-account credentials in the adapter's own local configuration. A provider's API key is a downstream bridge key when the bridge supports one; it is not automatically the website's session credential.

## Claude repository: source audit

Default branch `main`; commit **3715e797523890899ddc9f5839073a6459aa5846**, dated 2026-06-20. The repository was not archived when inspected. [Commit tree](https://github.com/cyberanrhy/claude-web2api/tree/3715e797523890899ddc9f5839073a6459aa5846).

### What is implemented

- [Core Python source](https://github.com/cyberanrhy/claude-web2api/blob/3715e797523890899ddc9f5839073a6459aa5846/claude_web2api.py): standard-library HTTP server with threaded requests; the only imported third-party library is `curl_cffi.requests.Session`.
- `GET /v1/models` returns a hardcoded OpenAI-shaped list. `GET /health` reports process status, whether any cookies loaded, organization id and rate-limit metadata. It does not perform a successful completion.
- `POST /v1/chat/completions` accepts messages and returns JSON or SSE. It creates a website conversation, flattens supplied message history into a prompt, requests generation, then attempts to delete that conversation.
- Upstream authentication uses the user's Claude web cookies and fetches an organization. Downstream `Authorization` headers are not validated: there is no local client authentication.
- Tool definitions are converted into text instructions, and returned XML-like invocations are parsed into OpenAI `tool_calls`. This is prompt-based emulation. The inspected request handler does not implement `tool_choice` semantics.
- There is no `/v1/messages` native Anthropic API, `/v1/responses`, dynamic authenticated model discovery or documented model-capability negotiation in this script.

### Setup facts, with discrepancies

The README says Python 3.10+ and directs users to `pip install -r requirements.txt`, but the inspected tree has **no `requirements.txt`**. It also lists a LICENSE and calls the project MIT, but **no LICENSE file is present** and GitHub's license metadata is null. Do not assume permission to redistribute a copied implementation merely from that README sentence.

The direct Windows entry point, after a user has separately prepared its environment and configuration, is:

```text
executable: C:\path\to\claude-web2api\.venv\Scripts\python.exe
arguments:  ["claude_web2api.py"]
working directory: C:\path\to\claude-web2api
health URL: http://127.0.0.1:8082/health
provider base URL: http://127.0.0.1:8082/v1
```

This is an entry-point description, **not a recommendation to start the unmodified script**. It has no CLI parser: `--config`, `--host` and `--port` are not supported. `load_config()` unconditionally opens `config.json` beside the script, so a fresh clone without that file fails before listening. `port` comes from that JSON. `cookie_file` can point to the user's separate Netscape-format cookie file; otherwise it uses `cookie_claude.txt` beside the script. The source does not install dependencies or provide a pinned version of `curl_cffi`.

Do not use the supplied [start_claude.sh](https://github.com/cyberanrhy/claude-web2api/blob/3715e797523890899ddc9f5839073a6459aa5846/start_claude.sh) as a desktop start command: it kills whichever process owns TCP 8082 and uses a developer-specific Linux path. The optional `panel.py` is a separate control application, not required for the API; this desktop manager should not launch it implicitly.

### Defects and limits that affect this app

1. **Network binding and auth:** `main()` binds `("0.0.0.0", port)` directly. The README's `host` configuration is not honored. No API-key middleware exists, and CORS is permissive.
2. **Model identity:** `model` is read and echoed in completion objects, but the upstream request payload contains only prompt, empty attachment/file lists and timezone. Requested model names are therefore not demonstrated to control the actual website model. The static `/v1/models` list must not be labeled verified account models.
3. **Prompt logging:** the request helper logs complete POST JSON bodies unconditionally; the stated `log_requests` setting is not checked there. Prompts can enter adapter logs.
4. **Cookie-format edge case:** the loader discards every line starting with `#`, which also discards Netscape `#HttpOnly_` entries. Some legitimate exports may therefore lose required cookies.
5. **Health-root mismatch:** `do_GET()` strips trailing slashes before matching. `/` becomes an empty string, so the apparent root-health branch does not match; use `/health`.
6. **Error fidelity:** some SSE failures are emitted as assistant text followed by a successful-looking stop marker. Some early failures call that SSE writer before headers are sent. A generic client cannot assume a finish marker proves successful upstream inference.
7. **Windows mismatch:** rate-limit metadata is hardcoded to `/tmp/claude_rate_limit.json`, and errors writing it are swallowed. The Unix start script is not portable despite the broad compatibility claim.
8. **No controlled tests here:** session freshness, current website compatibility, subscription limits, real model routing and reliable tool loops remain unverified. No bypass procedure was implemented or tested.

## Prepared-process recipes for the stronger candidates

These describe configuring an external bridge **after** its upstream setup has been reviewed and completed. They do not install packages, log in, export cookies or launch any process automatically.

### ChatGPT: tab2api

The inspected [package.json](https://github.com/tang-vu/tab2api/blob/decba9acb419baae449b3eb026acd9002efa31f0/package.json) requires Node >=22.13. Its source setup uses `npm ci`, a Playwright Chromium install, `npm run login` for manual browser authentication, then `npm run build`. Production entry point: `node.exe` with arguments `["dist/cli/index.js", "start"]`, working directory set to that checkout. No account password is entered into this desktop manager.

[Configuration](https://github.com/tang-vu/tab2api/blob/decba9acb419baae449b3eb026acd9002efa31f0/src/config/index.ts) defaults `TAB2API_HOST=127.0.0.1`, `TAB2API_PORT=3210` and validates loopback hosts. It creates `.tab2api/api-token`; provider requests use that local token. [Server routes](https://github.com/tang-vu/tab2api/blob/decba9acb419baae449b3eb026acd9002efa31f0/src/api/server.ts) distinguish unauthenticated `/healthz` from authenticated `/readyz`.

Use `chatgpt-web` for text on the OpenAI route. If using the adapter's documented client-tool bridge, select the **Anthropic protocol**, the same `/v1` base and its `claude-tab2api-chatgpt-web` compatibility id. That id still represents ChatGPT Web, not a Claude model. The answer/tool stream is buffered until UI completion. Exact model choice, native sampling controls and billing-grade token counts are not available. MIT license.

### DeepSeek and Qwen: FreeTokenAPI

Source setup uses a virtual environment and `python -m pip install -r requirements.txt`. The manifest lists FastAPI, Uvicorn, HTTPX, Pydantic v2, python-dotenv and Pillow. Prepared entry point: that environment's `python.exe`, arguments `["app.py"]`, cwd at the checkout. Python >=3.10 is enforced; DeepSeek additionally checks for its Node/native challenge runtime. Qwen-only operation does not need Node.

The inspected [.env.example](https://github.com/mmmlllnnn/FreeTokenAPI/blob/a54a9bb5d32413dea819ab0a0bc37dfc352de928/.env.example) uses `DEEPSEEK_TOKENS`, `QWEN_TOKENS`, `FREETOKENAPI_HOST=127.0.0.1`, and `FREETOKENAPI_PORT=8000`. It explicitly states that client API-key authentication is absent. An external token is not made safe for a network listener by entering an arbitrary provider key.

[Routes](https://github.com/mmmlllnnn/FreeTokenAPI/blob/a54a9bb5d32413dea819ab0a0bc37dfc352de928/freetokenapi/api/openai.py) implement root identity, `/health`, `/v1/models`, Chat Completions, plus separately implemented Responses and Messages. One process can serve both websites; provider profiles may share its base URL and choose different discovered model ids. DeepSeek exposes `deepseek-web` and, when available for an account, `deepseek-web-thinking`; do not replace discovery with a promised frontier-model label. [Tool code](https://github.com/mmmlllnnn/FreeTokenAPI/blob/a54a9bb5d32413dea819ab0a0bc37dfc352de928/freetokenapi/tools.py) builds prompt contracts and parses output. MIT license; all live-account capabilities remain untested here.

### Z.ai: glm-proxy

[go.mod](https://github.com/jubinjacob03/glm-proxy/blob/cc8165b675af2db10fb6ae85aa01cf33568c2e46/go.mod) requires **Go 1.26.7**, with Playwright-related and SQLite dependencies. An already prepared `zai-api.exe` has the documented argument `--agent-mode`; [run.go](https://github.com/jubinjacob03/glm-proxy/blob/cc8165b675af2db10fb6ae85aa01cf33568c2e46/internal/zbridge/run.go) implements `/health`, authenticated `/v1/models`, `/v1/chat/completions` and `/v1/messages`.

[Configuration](https://github.com/jubinjacob03/glm-proxy/blob/cc8165b675af2db10fb6ae85aa01cf33568c2e46/internal/zbridge/config.go) uses `HOST=127.0.0.1`, `PORT=3007`, website `ZAI_TOKEN`, and separate local `AUTH_TOKEN`. The example ships known local keys: replace those in the user's external configuration. The script loads `.env`; do not place real keys in process arguments or a committed recipe. [Model source](https://github.com/jubinjacob03/glm-proxy/blob/cc8165b675af2db10fb6ae85aa01cf33568c2e46/internal/zbridge/models.go) falls back when live discovery fails. The README's guest/account model-access claims were not tested. MIT license. Browser/device-auth initialization remains a separate upstream requirement; no challenge-handling instructions or machinery are added by this desktop app.

### Multi-provider: g4f

GPL-3.0; keep it as an optional external service. The inspected [CLI](https://github.com/xtekky/gpt4free/blob/70a3d3263d07975adfd5000fa49af8d61af6c5c8/g4f/cli/__init__.py) supports an explicit loopback launch such as arguments `["-m", "g4f", "--bind", "127.0.0.1:8084", "--no-gui", "--disable-pa-auto-download"]` for the user's prepared Python environment. The bind option requires `host:port`. Choose a reviewed provider explicitly; do not infer website or model identity from `auto` routing. [Config](https://github.com/xtekky/gpt4free/blob/70a3d3263d07975adfd5000fa49af8d61af6c5c8/g4f/config.py) supports a local `G4F_API_KEY` environment variable. Keep its secret outside saved public arguments; Bearer and `g4f-api-key` are accepted by the API middleware. Provider-specific dependencies can include browsers and login material.

The [ChatGPT adapter](https://github.com/xtekky/gpt4free/blob/70a3d3263d07975adfd5000fa49af8d61af6c5c8/g4f/Provider/ChatGPT.py) controls a browser and reports no system-message/history support. The [DeepSeek adapter](https://github.com/xtekky/gpt4free/blob/70a3d3263d07975adfd5000fa49af8d61af6c5c8/g4f/Provider/needs_auth/DeepSeek.py) needs authentication and conditional runtime dependencies. These source flags are not live tests.

The [Claude adapter](https://github.com/xtekky/gpt4free/blob/70a3d3263d07975adfd5000fa49af8d61af6c5c8/g4f/Provider/needs_auth/Claude.py) is disabled by default and points to `claude.gpt4free.workers.dev`, forwarding the configured Claude cookie to that endpoint. Do not enter the user's Claude cookies into that adapter under an assumption of local-only handling. A direct Z.ai web adapter was not verified in this review. Therefore g4f is not recommended as a one-click solution to all six requested websites.

## Verification expectations

The desktop can report: executable configured, child process started, loopback HTTP responding, advertised models retrieved, and separately a user-initiated inference test. Keep those statuses distinct. A model name in a static list, successful `/health`, or a compatibility alias is not proof of model identity, native tools, authenticated account access or continuing availability. Leave incompatible profiles unstarted and show their source/setup notes instead of claiming completed website integration.
