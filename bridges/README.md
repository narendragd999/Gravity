# Optional Web2API bridge sources

The new [standalone DeepSeek, Qwen, ChatGPT, and Z.ai bridge](multi-web2api/README.md) runs at `http://127.0.0.1:4320/v1` with a generated local token. DeepSeek/Qwen use direct requests; ChatGPT/Z.ai use dedicated website profiles and network SSE capture. It is independent of the Browser Connector extension. Setup, model discovery, and optional account probes are documented separately from automated tests.

These source snapshots preserve the external Gemini and Claude bridge projects used during Gravity development. They are separate from Gravity's [Browser Connector extension](../browser-extension/README.md), which already supports signed-in Claude and Gemini tabs without Python, Go, exported cookies, or an external bridge process.

The Gemini/Claude snapshots are included in this source repository. Their executables and runtimes are **not bundled in the Gravity desktop executable**. They are optional services: prepare a bridge separately, then connect it through **Settings → Web2API Bridges**. The four-provider service is bundled in **Gravity 1.7.0** with Node: use **Settings → Get started → Connect & start** for setup without keys or terminal commands. A separately prepared `Gravity-Web2API` companion with [Windows launchers](multi-web2api/WINDOWS.md) remains available for advanced standalone use. See [managed and external bridge setup](../docs/UNIVERSAL-WEB2API.md). Copying sources alone does not configure an account or start a service.

## Source provenance

| Snapshot | Upstream | Pinned commit | Local changes |
| --- | --- | --- | --- |
| [Gemini Web2API](gemini-web2api/README.md) | [ikhsan3adi/gemini-web2api](https://github.com/ikhsan3adi/gemini-web2api) | [`4b9ce2674313dac8940f9277bd89a6c550dc1b0e`](https://github.com/ikhsan3adi/gemini-web2api/tree/4b9ce2674313dac8940f9277bd89a6c550dc1b0e) | Source and build files match the inspected checkout. Upstream GitHub workflows and funding metadata were omitted. |
| [Claude Web2API](claude-web2api/README.md) | [cyberanrhy/claude-web2api](https://github.com/cyberanrhy/claude-web2api) | [`3715e797523890899ddc9f5839073a6459aa5846`](https://github.com/cyberanrhy/claude-web2api/tree/3715e797523890899ddc9f5839073a6459aa5846) | Includes the three existing local Python changes listed below and an added dependency manifest. Upstream `server.log` was omitted. |

Snapshots were copied on 2026-11-04. No nested Git metadata, virtual environment, dependency cache, binary, log, active configuration, or account cookie file is included. Gemini's upstream `config.example.json` is an example and contains placeholders. Upstream README files are preserved as reference material; their claims are not Gravity validation results.

## Gemini

The Go source includes its `go.mod`, `go.sum`, tests, Docker build files, example configuration, and upstream [MIT license](gemini-web2api/LICENSE), copyright 2026 Ikhsan Satriadi. The pinned `go.mod` declares **Go 1.26.5**; use that requirement when building this snapshot even if older upstream README prose names an earlier toolchain.

Gravity's Gemini bridge manager uses a separately prepared executable and a user-selected private configuration. The source snapshot does not include the local Gemini executable or any user's configuration or cookies.

The upstream example binds to all interfaces and uses a public sample API key. For a local external launch, use a private configuration with `host` set to `127.0.0.1`, your own API key, and `log_requests` disabled.

## Claude

The copied `claude_web2api.py` retains these existing local changes relative to the pinned upstream commit:

1. `log()` is disabled, preventing that logger from printing prompts and responses.
2. Netscape cookie entries beginning with `#HttpOnly_` are retained after removing that prefix.
3. The HTTP listener binds to `127.0.0.1` instead of `0.0.0.0`.

These changes do not add downstream API authentication, verified model selection, or live website compatibility. The core still requires a private adjacent `config.json` and the user's separately stored Claude cookies. Neither is supplied here.

The added [requirements.txt](claude-web2api/requirements.txt) pins the runtime dependencies found in the inspected Windows Python 3.13.1 environment. An import audit of both Python files found `curl_cffi` as the only third-party import; the manifest also pins its installed runtime dependencies. This records the dependency versions, not a successful live account test. The packages require Python 3.10 or newer.

Use the Python core entry point when preparing a managed bridge. The preserved upstream `start_claude.sh` contains a developer-specific absolute path and terminates whichever process owns TCP 8082; it is not a Gravity launcher. `panel.py` is an optional separate upstream control panel and is not started by Gravity automatically.

Gravity supplies Windows `Setup.cmd`, `Start.cmd`, and `config.example.json` alongside this snapshot. Setup creates a virtual environment and preserves an existing private configuration; Start requires your own site-only cookie export. Follow the [beginner Windows guide](../docs/CLAUDE-WEB2API-WINDOWS.md) for manual launch or a Gravity-managed Python profile. These helpers do not change the upstream website protocol or establish live account compatibility.

**License provenance:** the upstream Claude README states “MIT”, but the pinned repository does not provide a LICENSE file or complete copyright/license notice. This snapshot preserves that declaration and does not invent a license notice or relicense the upstream files. Gravity's root MIT license does not resolve the missing upstream notice.

## Validation scope

Copied source files were checked against their source checkout, and selected files were scanned for high-confidence embedded credentials before inclusion. The Claude Python files parse successfully. These source snapshots were not installed or launched as part of their inclusion, and no live Gemini or Claude inference was verified.
