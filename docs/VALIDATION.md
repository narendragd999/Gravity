# Validation — 3 November 2026

## Version 1.7.0 — 5 November 2026

- 339 Node regression/integration tests passed on Windows; TypeScript/Vite production build and portable packaging passed.
- Native desktop smoke passed for Chat mode, saved-line context and revision preflight, request timing, image capabilities, safe diagnostics, one-click startup, file apply/review/Undo, passive project guidance, provider switching, permissions and browser pairing. Relevant screenshots were visually inspected.
- The cleaner desktop layout was checked in light/dark themes and at 980 × 640 with 125% text. Routine connection details and finished-request timing are collapsed; recovery controls remain visible. The source-archive regression confirms named cookie exports remain excluded.
- Delayed browser-probe fixtures cover concurrent setup views, Connect while checking browsers, cancellation, app closure and bounded timeout recovery.
- 18 isolated Electron DOM checks passed across the six website adapters and history/draft/challenge/password/expiry/cancellation safeguards.
- The portable executable launched from an isolated folder with spaces without developer runtimes on PATH. Its embedded website service completed setup without sidecar files, system Node, live website traffic or inference. Authentication, encrypted local keys, automatic startup and preferences were checked.
- Migration tests retain original profiles during busy/interrupted/corrupt recovery, refuse links, and validate operation after the old release folder is removed. Export/import excludes credential and service settings and executable approvals.
- The included Claude Python source parses; the beginner guide and Windows setup/start launchers are included. No live Claude account was used.
- Current-account authentication/generation and a fresh Windows virtual machine remain acceptance checks. Fixture success is not proof of live website compatibility.

## Version 1.4.3

- **152 Node integration and regression tests passed on Windows.** New checks verify extension protocol/version headers, legacy-client rejection before pairing or prompt delivery, recovery without weakening authentication, stable install paths and updating recognized old folders, refusal of redirected destinations, bounded hung probes/queries/run-result waits, and cancellation without waiting for Chrome. A run injection is never retried after timeout or cancellation.
- **17 isolated Electron DOM checks passed.** These cover six website fixtures, existing history/draft/password/challenge safeguards, cancellation, remaining generation time, and expiry before input or submission.
- The exact old error strings reported by the user were absent from 1.4.2's current extension while older prepared extension folders still contained 1.0.0. That supports stale loaded extension code as a cause. No live website reply or active Chrome extension configuration was inspected.
- The desktop and extension now expose versions and require protocol 2. The desktop version is 1.4.3 and companion extension version is 1.0.2. Live website/account compatibility remains unverified.
- TypeScript and the production build passed. Native Electron smoke checks passed for an outdated-extension upgrade error, a compatible extension version, pairing, Qwen response testing, browser round trips, and existing provider/gateway/permission flows. The setup screen was visually checked. Tests use disposable app data and local fixtures.

## Version 1.4.2

- **142 Node integration and regression tests passed on Windows.** New coverage includes extraction from a real ASAR with Electron, Qwen/Z.ai readiness while Chrome still reports loading, delayed input, bounded generation time, readiness failure, foreign redirects, cancellation before submission, and strict whole-response tool formatting.
- The original `fs.cp` failure was reproduced against the running 1.4.1 packaged archive. The replacement extracted all nine extension files from that same archive and matched their source bytes.
- **14 isolated Electron DOM checks passed**, including the six website adapters, code extraction, existing-history/draft/hostname/challenge/password safeguards, cancellation, and shortened remaining generation budgets. These are local fixtures without website accounts.
- TypeScript checking, the Vite production build, and Windows x64 portable packaging passed with Electron 39.8.10. The companion extension is version 1.0.1.
- Native Electron smoke checks passed with disposable app data and a simulated extension. The Qwen site-card test sent only the short test prompt to Qwen, preserved the provider's Claude default, displayed a completed-response result, and cleared the result after revocation. Existing desktop, provider, bridge, gateway, and permission checks also passed. The website cards and setup screen were visually checked for clipping.
- The packaged file inventory and bytes are compared with current build inputs; the source ZIP is checked separately and artifact checksums are written to `release/SHA256SUMS-1.4.2.txt`.
- Live Qwen/Z.ai/Claude response generation and a clean-machine installation have not been verified. The exact failed Claude response was unavailable; stricter prompting reduces the known narrative/JSON mismatch but does not establish compatibility with every live website layout.

## Version 1.4.1

- **132 Node integration and regression tests passed on Windows.** The new checks cover nine generation-testing cases and four conversation provider/model state transitions.
- Model-list success followed by generation failure now returns failure. Tests verify the exact selected model, a minimal request without conversation/project/tool data, manual model IDs when discovery is unavailable, empty responses, timeout handling, credential redaction, and browser readiness for the selected website.
- Changing a failed conversation's provider/model clears the old error state; unchanged selections, unrelated edits, rejected inputs, and running conversations retain their original behavior. Conversation messages and API history survive the switch.
- TypeScript checking and the Vite production build passed. The Windows x64 portable build completed using Electron 39.8.10.
- **Native Electron smoke checks passed** for misleading discovery success, real generation testing, opening Settings on the current provider, explicit provider switching with history preserved, clearing old error state, and the Claude browser recovery shortcut. They also verify six discoverable browser routes while unpaired, missing-tab failure after pairing, a simulated extension response, and the existing permissions/bridge/gateway flows.
- **13 isolated browser DOM checks passed.** These and the native browser round trip use synthetic fixtures, not real website accounts.
- Provider settings, model test actions/results, selected chat connection, and Claude recovery prompts were visually checked in Electron screenshots. The first recovery test run used a project-conversation selector for a projectless fixture; assigning its intended fixture project fixed the test setup. No application workaround was needed.
- Packaging verification compares the bundled application and source ZIP to current inputs and creates `release/SHA256SUMS-1.4.1.txt`. Previous versioned releases are retained. The executable is a portable Windows x64 build.
- **Live Claude generation has not been verified.** The release fixes provider-selection and misleading-test behavior; using Chrome still requires starting its connector, pairing the extension after restart, and opening a signed-in Claude tab.
- The initial full suite exposed an existing concurrent-write test that incorrectly assumed which asynchronous write would reach the queue first. It now verifies exactly one write succeeds, the competing stale write is rejected, and the file contains the winning content. The focused test and subsequent full 132-test suite passed; filesystem implementation was unchanged.

## Version 1.3.0

- **119 Node integration and regression tests passed on Windows.** These include 15 browser-connector tests, 15 extension tests, 11 permission-policy tests, 15 configurable bridge tests, and 10 headless universal-service tests.
- Connector tests verify independent API/extension tokens, explicit pairing, nonce expiry, host/origin restrictions, cookie rejection, request/result validation, six-site routing, cancellation, heartbeat loss, and buffered SSE. Extension tests verify prompt/tool envelopes, exact site allowlists, pairing/disconnect races, recovery storage, and the 256-message boundary.
- **13 synthetic Electron DOM checks passed** across Claude, ChatGPT, DeepSeek, Qwen, Z.ai, and Gemini adapters, plus history/draft/password/challenge/hostname/cancellation safeguards. These use local fixtures and no website accounts.
- TypeScript checking and the Vite production build passed.
- **The native Electron smoke test passed.** Alongside the existing checks below, it automatically creates six model aliases, approves a simulated extension through the renderer, reports six site statuses, completes an agent round trip through that simulated extension, and revokes its access.
- The browser setup and six-site cards were visually checked in Electron screenshots. Screenshots show fixture statuses, not connected user accounts. Existing permission and bridge screens were also captured.
- The first native smoke run, concurrent with the Node suite, timed out during owned-process termination. Twenty focused early-cancellation cycles in Electron passed; subsequent sequential native smoke passed. A related failure-handling defect was fixed and regression-tested: failed termination now retains the owned process and port reservation for a later retry.
- Tests use disposable profiles, temporary workspaces, and local HTTP fixtures. They do not change the user's saved providers or use their browser credentials. Expected IPC rejections for unconfirmed Full access, locked connections/profiles, linked-provider removal, and cancelled startup are logged.

The Chrome extension must still be installed and paired in the user's Chrome profile. **Live generation through the new browser connector has not been verified on any of the six websites.** Account limits, sign-in challenges, website layouts, and completion controls can prevent operation. The connector reports failure when it cannot establish a new completed response; fixture success is not evidence of live compatibility.

Run `npm test`, `npm run build`, `npm run test:desktop`, and `node node_modules/electron/cli.js tests/electron-browser-dom.mjs`. The native smoke test additionally saves `artifacts/browser-setup.png` and `artifacts/browser-sites.png`. No project content is sent to remote providers by these tests.

Packaging verification compares the bundled app and source archive with their current source inputs, rejects credential/runtime paths, and writes `release/SHA256SUMS-1.3.0.txt`. The Windows x64 package uses Electron 39.8.10. Earlier portable releases remain available.

## Earlier validation — 2 November 2026 (version 1.2.0)

- 88 Node integration and regression tests passed on Windows. These include 11 permission-policy tests, 14 configurable bridge tests, 10 headless universal-service tests, and a stopped-provider connection diagnostic test.
- The configurable bridge suite exercised encrypted/masked environment settings, URL and executable validation, real Windows foreground-process launch/restart, exact arguments, authenticated readiness, port conflicts, cancellation, bounded log redaction, and owned child/grandchild termination. The headless suite exercised multi-provider protocol routing, startup rollback, gateway-bind failure, credential references, no state-file writes, cancellation/restart, and cleanup failures.
- TypeScript checking and the Vite production build passed.
- Electron smoke test passed for native-window creation, React rendering, main-frame IPC, OS-encrypted provider credentials, model discovery, workspace reads, streamed agent conversation, gateway authentication, and clipboard output. It also exercised the three-option permission menu, Full access cancellation and explicit confirmation, rejection of unconfirmed Full access through IPC, persisted selection, unchanged Plan mode, and the Ask for approval default on a new chat. It uses an isolated temporary profile, local fixture provider, and available test gateway port without changing the user's running service or settings.
- The permissions popup was visually checked in an Electron screenshot; its controls and scope text are visible without clipping.
- The native smoke test also created an external bridge profile through the UI, checked it twice, disconnected it without stopping the fixture service, verified profile/provider connection locks while allowing model-list saves, cancelled a managed startup through the UI, and verified bridge-environment encryption. The new Web2API settings page was visually checked in an Electron screenshot.
- Version 1.2.0 Windows x64 portable executable uses Electron 39.8.10; the runtime download was checked against the SHA-256 supplied by its official npm package.
- The existing local gemini-web2api executable/configuration successfully served its health endpoint and 13 advertised model IDs. A real request using the advertised `gemini-3.6-flash` ID returned `READY`. The first request timed out at 60 seconds; a retry using the adapter's normal 180-second allowance succeeded. This verifies one live session/request, not every advertised model or future session validity.
- A separate Argon check returned HTTP 200, `X-Resolved-Model: gemini-4-argon`, no fallback header, and `READY.`. This verifies the bridge's configured route and a successful response; it does not independently attest to the underlying Google model identity.
- Claude, ChatGPT, Qwen, DeepSeek, and Z.ai bridge sources were reviewed, but no new website session was used and no live generation for those services was verified. The provided Claude repository has unresolved behavior and configuration defects. It is not bundled or installed. See [the pinned source audit](WEB2API-RESEARCH.md).
- Native Windows screen capture timed out, so rendering was additionally checked using Electron's own screenshot capture and the browser preview. Background process launch was rejected by automatic approval; a foreground isolated test process succeeded.

Reproduce with `npm test`, `npm run build`, and `npm run test:desktop`. The desktop smoke test runs its own local HTTP server and leaves screenshots under `artifacts/desktop-smoke.png`, `artifacts/permissions-menu.png`, and `artifacts/web2api-bridges.png`. Expected IPC rejections for unconfirmed Full access, locked connections/profiles, linked-provider removal, and cancelled startup are logged during the test. It creates no external accounts and sends no project content to a remote provider. Live-provider tests were separate and used only the generic connection-test prompt.
