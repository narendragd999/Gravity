# Research, implementation, and parity

This is an independent implementation of a desktop coding-agent workspace. Its design reference is the current public [Google Antigravity overview](https://antigravity.google/docs/overview), inspected on 2 November 2026. It is not a redistribution of Google's app or a verified reproduction of its private agent backend. No proprietary application source, logos, account state, or service credentials are included.

## What was learned

The public desktop design places project and conversation navigation in a left sidebar, agent messages and a model-aware composer in the center, and inspectable work such as files, plans, terminal output, and changes alongside the conversation. This implementation follows that workflow with original React components and Electron desktop services.

[REA](https://github.com/morluto/rea), inspected at commit `144843ccc26bd372d61b8c6a27b37a01a5b0fb61` (package 6.8.0, MIT), is a local analysis toolkit. It supports desktop inventory and static JavaScript/Electron analysis, including directory or ASAR inputs, module and IPC graphs, and evidence-based feature tracing. Static graph reachability is evidence about possible connections, not proof of runtime behavior. REA is not an automatic complete-app cloning engine. Its code is not embedded in this app.

The method applied here was to identify the public feature surface, inspect the supplied repositories and their actual entry points, record protocol behavior and limitations, and implement explicit boundaries between the renderer, privileged workspace service, model adapters, and HTTP gateway. Source checkouts and original research notes are in the neighboring `references` directory. REA's dependencies and MCP setup were not installed; its CLI was not run against the proprietary app. No binary patching, injection, credential extraction, or reconstruction of Google's private services was performed.

[gemini-web2api](https://github.com/ikhsan3adi/gemini-web2api), inspected at commit `4b9ce2674313dac8940f9277bd89a6c550dc1b0e` (MIT), converts Gemini's web protocol into OpenAI-compatible and Google-compatible HTTP endpoints. The app integrates it through its HTTP interface and optional local process management. The reference's actual `go.mod` requires Go 1.26.5. Its `--config` setting controls the host; there is no `--host` CLI flag. A local configuration should explicitly bind `127.0.0.1`.

The bridge's `/v1/models` endpoint lists a registry, not verified account entitlements. Unknown model names may fall back silently, and tool calling is parsed from prompted output. Requests with tools may arrive as one buffered SSE event. Process health does not establish successful inference, model identity, or valid Google credentials. The app's protocol tests use controlled local HTTP servers and do not claim to verify upstream account access.

## Delivered architecture

| Boundary | Implementation |
| --- | --- |
| Desktop renderer | React, local Monaco editor, Markdown messages and artifacts, project navigation, settings, and review controls |
| Privileged backend | Electron IPC, durable conversations/settings, encrypted provider credentials, scoped file operations, and reviewed command execution |
| Agent loop | Streaming provider requests, bounded tool steps, Plan/Build modes, approvals, cancellation, and independent concurrent conversations |
| Provider adapters | OpenAI-compatible APIs plus native Anthropic and Gemini translation; configurable base URL and custom model IDs |
| Local API | Token-authenticated loopback gateway exposing health, model listing, and chat completions with SSE |
| Gemini bridge | Integration with an independently installed gemini-web2api executable and user-managed configuration |

## Practical limits

This implementation does not provide Google's private agent harness, its extension marketplace, full VS Code extension host, browser automation, remote-control service, SSO, team administration, or proprietary cloud integrations. The command panel is a bounded non-interactive shell runner, not a PTY. Commands run with the user's operating-system permissions, after manual approval or automatically under a selected Full access policy; the shell is not a filesystem sandbox. File tools are scoped to the selected workspace and reject path escapes and redirected paths. File writes preserve backups and reject stale contents regardless of permission mode. See [permissions](PERMISSIONS.md) for the independently implemented approval controls.

The exposed gateway implements `/health`, `/v1/models`, and `/v1/chat/completions`. The upstream Gemini bridge supports additional routes such as `/v1/responses`, but those extra routes are not implied by the gateway's API. Provider behavior, authentication requirements, context limits, model availability, and tool support remain properties of the configured upstream service.

Further parity work should start with a specific user-visible behavior and reproducible reference observation, then track implementation, test evidence, and remaining uncertainty separately. This document intentionally distinguishes delivered behavior from unverified parity.
