# Optional Web2API bridge sources

The new [standalone DeepSeek, Qwen, ChatGPT, and Z.ai bridge](multi-web2api/README.md) runs at `http://127.0.0.1:4320/v1` with a generated local token. DeepSeek/Qwen use direct requests; ChatGPT/Z.ai use dedicated website profiles and network SSE capture. It is independent of the Browser Connector extension. Setup, model discovery, and optional account probes are documented separately from automated tests.

These source snapshots preserve the external Gemini and Claude bridge projects used during Gravity development. They are separate from Gravity's [Browser Connector extension](../browser-extension/README.md), which already supports signed-in Claude and Gemini tabs without Python, Go, exported cookies, or an external bridge process.

The Gemini/Claude snapshots are included in this source repository. Their executables and runtimes are **not bundled in the Gravity desktop executable**. They are optional services: prepare a bridge separately, then connect it through **Settings → Web2API Bridges**. The four-provider service is bundled in **Gravity 1.7.0** with Node: use **Settings → Get started → Connect & start** for setup without keys or terminal commands. A separately prepared `Gravity-Web2API` companion with [Windows launchers](multi-web2api/WINDOWS.md) remains available for advanced standalone use. See [managed and external bridge setup](../docs/UNIVERSAL-WEB2API.md). Copying sources alone does not configure an account or start a service.

## Source provenance

| Snapshot | Upstream | Pinned commit | Local changes |
| --- | --- | --- | --- |
| [Gemini Web2API](gemini-web2api/README.md) | [ikhsan3adi/gemini-web2api](https://github.com/ikhsan3adi/gemini-web2api) | [`4b9ce2674313dac8940f9277bd89a6c550dc1b0e`](https://github.com/ikhsan3adi/gemini-web2api/tree/4b9ce2674313dac8940f9277bd89a6c550dc1b0e) | Includes the local empty-response, retry, tool-parser, and SSE changes listed below, plus regression tests. Upstream GitHub workflows and funding metadata were omitted. |
| [Claude Web2API](claude-web2api/README.md) | [cyberanrhy/claude-web2api](https://github.com/cyberanrhy/claude-web2api) | [`3715e797523890899ddc9f5839073a6459aa5846`](https://github.com/cyberanrhy/claude-web2api/tree/3715e797523890899ddc9f5839073a6459aa5846) | Includes the three existing local Python changes listed below and an added dependency manifest. Upstream `server.log` was omitted. |

Snapshots were copied on 2026-11-04 and subsequently changed as documented here. The source repository and source archive exclude nested Git metadata, virtual environments, dependency caches, binaries, logs, active configurations, and account cookie files. Gemini's upstream `config.example.json` is an example and contains placeholders. Upstream README files are preserved as reference material; their claims are not Gravity validation results.

## Gemini

The Go source includes its `go.mod`, `go.sum`, tests, Docker build files, example configuration, and upstream [MIT license](gemini-web2api/LICENSE), copyright 2026 Ikhsan Satriadi. The pinned `go.mod` declares **Go 1.26.5**; use that requirement when building this snapshot even if older upstream README prose names an earlier toolchain.

Gravity 1.9.0 adds these local changes to the pinned Gemini source:

1. Empty or metadata-only generation and streaming responses fail with `empty_response`, without replaying the prompt. Zero or negative retry counts perform one request.
2. The stream reader accepts valid final JSON without a trailing newline, preserves cumulative prefixes, and rejects an empty retry even after an earlier partial answer.
3. OpenAI and Google tool parsers validate the complete action batch. Malformed or incomplete fences and invalid arguments return an error instead of discarding bad blocks or returning only valid calls. Valid tool-only replies remain supported.
4. Chat/Google streaming emits an error event when generation fails, and JSON endpoints return explicit failure codes. Empty output does not produce a successful finish marker.
5. Added extraction, stream, tool-parser, and endpoint tests use authored fixtures and local HTTP mocks. Existing server tests were made deterministic instead of calling a live upstream service.

The optional **`Gravity-Gemini-Web2API-1.9.0-x64.exe`** is generated as an **unsigned development build** by `scripts/package-gemini.mjs` or the full Windows development release check. It is placed in `release/`, included in reviewable Windows development workflow artifacts, and added to the versioned checksum file when present. Its linked version is `gravity-1.9.0`. The signed release workflow publishes the desktop and source archive and excludes this optional bridge by default; the bridge is not bundled into the desktop executable or delivered by its verified update download.

Gravity's Gemini bridge manager launches the executable and private configuration the user explicitly selects. An existing external executable is retained until the user chooses the rebuilt one. Follow the [beginner Gemini guide](../docs/GEMINI.md) for artifact availability, explicit selection, model discovery, and private cookie/configuration setup. No working configuration or account cookies are provided.

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

The initial snapshots were checked against their source checkout, and selected files were scanned for high-confidence embedded credentials before inclusion. The later Gemini changes passed 57 top-level Go tests (99 including subtests) across five tested packages with Go 1.26.5. These checks use local fixtures and mocks; they do not establish live Gemini account/model compatibility. The Claude Python files parse successfully. No live Gemini or Claude inference was verified for these source changes.
