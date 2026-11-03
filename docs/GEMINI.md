# Gemini web2api integration notes

Inspected 2026-11-02, upstream [ikhsan3adi/gemini-web2api](https://github.com/ikhsan3adi/gemini-web2api), commit `4b9ce2674313dac8940f9277bd89a6c550dc1b0e`. MIT license, copyright 2026 Ikhsan Satriadi. This checkout is reference material; the desktop adapter is an independent HTTP client.

## Verified server interface

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Process health, version, registry model names |
| GET | `/v1/models` | OpenAI-shaped model registry |
| POST | `/v1/chat/completions` | Chat JSON or SSE |
| POST | `/v1/responses` | Responses-format adapter |
| GET | `/v1beta/models` | Google-shaped model registry |
| POST | `/v1beta/models/{model}:generateContent` | Google JSON generation |
| POST | `/v1beta/models/{model}:streamGenerateContent` | Google SSE generation |

Set a desktop OpenAI-compatible provider base URL to `http://127.0.0.1:8081/v1`. Discover names from `/models`; accept manually entered names because model registries vary by service. The bridge itself silently maps unknown model names to its default; response headers `X-Resolved-Model` and `X-Model-Fallback` describe that routing. Registry names are not proof that an account has access to an advertised upstream model.

## Setup and lifecycle

The actual `go.mod` requires **Go 1.26.5**, despite the README's older Go 1.22+ statement. Build with `go build -o gemini-web2api.exe .`, or use a reviewed upstream release binary. Supported flags in `main.go`: `--port`, `--config`, `--cookie-file`, `--proxy`, `--impersonate`, `--version`. There is **no host CLI flag**. Supply an explicit config containing `"host": "127.0.0.1"` for a local desktop service; upstream defaults to all interfaces (`0.0.0.0`). Config resolution is flag, `GEMINI_WEB2API_CONFIG`, working-directory `config.json`, then user config directory. CLI port overrides config port.

The desktop should launch only the user-selected executable, with an explicit config and working directory, retain a bounded output log, wait for GET `/`, and stop only its own child process. Startup performs blocking upstream build-label refresh and account model discovery before listening. A healthy HTTP listener does **not** establish working Google credentials or successful inference. Check actual generation separately.

## Authentication and configuration

When `api_keys` is nonempty, all `/v1*` routes (including `/v1beta`) require a matching Bearer token, `x-api-key`, `x-goog-api-key`, or query key. GET `/` remains unauthenticated. Empty keys disable auth. Recommended desktop use is loopback plus a random API token. Upstream CORS is permissive and request bodies are limited to 32 MiB.

Config fields include host/port, retries, delay, timeout, default model, build label, auth account index, XSRF token, API keys, cookie file, proxy, impersonation, request logging and temporary chats. Credentials should stay in user-managed configuration; do not include them in source, renderer state, logs, or packaging. No existing user credential file was inspected for this research.

## Streaming and tool behavior

Chat streaming without tools emits incremental OpenAI chunks followed by a finish chunk and `[DONE]`. With tools enabled, it buffers the upstream answer and returns one SSE chunk containing parsed calls. Calls are **prompt-emulated** from fenced JSON, not guaranteed native structured function calls. The client must therefore accept a single chunk containing complete calls and no call `index`. Definitions above 30 KB are reduced upstream to names/descriptions, losing parameter schemas. The bridge approximates token counts from character lengths.

Every request creates an independent upstream conversation; earlier messages are flattened into a prompt. Paid-account routing, upstream model availability, throttling, session expiry and changing private web protocols can affect results. The bridge source advertises model names including `gemini-3.6-flash` and aliases; those are upstream repository claims, not an independent model-identity verification. A desktop should surface HTTP and streaming failures, allow cancellation, and never label process health as successful inference.

## Source evidence

Routes: `internal/server/server.go`; health/discovery: `handlers.go`; auth/CORS: `middleware.go`; chat SSE and tool buffering: `chat.go`; prompt conversion and fenced-call parsing: `internal/format/openai.go`; aliases/fallback: `internal/models/models.go`; defaults: `internal/config/config.go`; startup/CLI: `main.go`.
