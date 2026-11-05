# Gravity improvement plan

Prepared on 5 November 2026 for Gravity 1.5.4.

## Implementation status

The planned feature code is now included in Gravity 1.7.0: normal-browser account setup and staged recovery, isolated website connections, final-answer parsing, simpler chat controls, saved-data migration and backups, and file context/review/Undo/project guidance. The findings and proposed release sequence below record the original review, rather than the current implementation state. See [the release notes](RELEASE-1.7.0.md) for the delivered behavior and validation limits.

Current-account sign-in/generation and fresh-Windows-machine acceptance checks still require live verification. Automated fixtures do not establish those outcomes.

### Completion record

| Planned work | Implemented in 1.7.0 | Verification |
|---|---|---|
| Sign-in progress, recovery and Qwen authentication | Normal Chrome/Edge auth for four sites, structured errors, safe diagnostics, per-account browser preference | Login, manual-flow, configuration and setup fixtures; desktop setup smoke |
| Clean responses and tool format | Verified Z.ai reasoning-wrapper separation and text replies for ordinary requests; whole-envelope action validation retained | Provider-stream fixtures, tool-format and server tests |
| Preserve working accounts | Account-scoped profile release, deferred idle reload, rollback and independent startup availability | Lifecycle, startup-failure and cancellation tests |
| Beginner connections | One website route, collapsed advanced fields, status/recovery beside chat and timestamped explicit response checks | Native desktop smoke and visual inspection |
| Chat, models and attachments | Tool-free Chat, website route labels, capabilities, pre-submit image rejection | Agent tests, desktop request-body and preflight assertions |
| Saved data and upgrades | Checked atomic migration with retained originals, busy/interrupted/corrupt recovery, nonsecret export/import | Recovery fixtures, migration profile rebasing tests |
| Context, review and Undo | Bounded saved-file line references, revision preflight, per-file diffs, persisted agent provenance and guarded Undo | Workspace/agent tests and desktop apply-review-Undo flow |
| Run/test guide and timing | Passive project detection, displayed commands and actual request timestamps | Workspace command-detection tests and desktop no-execution assertions |

The final Node suite passed **339 tests**. Native desktop smoke and **18 isolated Electron DOM checks** passed. Screenshots of setup, context, review and project guidance were inspected. See [release notes](RELEASE-1.7.0.md) for upgrade steps and validation limits. The optional [Claude Web2API guide](CLAUDE-WEB2API-WINDOWS.md) and Windows setup/start launchers are included.

The built portable executable passed an isolated-folder launch with no developer runtimes on PATH. Its embedded website service started through the in-app setup without companion files or live website requests. Local authentication, OS-encrypted provider keys, saved preferences and managed startup were verified.

## Recommendation


Deliver a focused reliability release first. Its main outcomes should be a diagnosable ChatGPT sign-in flow, normal-browser Qwen authentication, and clean Z.ai answers. Follow with simpler connection controls, accurate model/input capabilities, and durable saved data. Improve the coding workspace after those foundations work consistently.

This document preserves the original review and implementation plan. Implementation has since proceeded as described above.

## Confirmed issues

### ChatGPT sign-in failure

- The supplied screenshot shows a failed ChatGPT setup and the generic message: “Website sign-in did not finish.”
- Current saved configuration has Z.ai enabled and ChatGPT disabled. The dedicated ChatGPT profile exists.
- The running app, source, and companion login files match. This is not an outdated helper or a missing local API key.
- The backend replaces all nonzero login-helper exits with one message. It loses the actual failure stage and recovery instructions.
- Follow-up from the user: the separate browser opened, they signed in, saw an empty ChatGPT chat, and then closed the browser. Missing browser launch or an omitted manual sign-in step therefore does not explain the observed attempt.
- After that manual step, the helper reopens the same dedicated profile through its browser driver, navigates to ChatGPT, and checks the message box, page location, history, and draft before enabling the connection. The user's observation does not establish whether this reopened verification browser passed those checks.
- The exact failing stage remains unknown. Browser/profile closure or persistence, a sign-in/security page appearing on reopening, restored history/draft, and an unavailable message box remain possible causes, not confirmed diagnoses. Do not treat repeated manual sign-in or deleting the saved profile as the established fix.

Implementation location: [web2api-setup.mjs](E:/application/Antigravity/Gravity/electron/web2api-setup.mjs), [cli.mjs](E:/application/Antigravity/Gravity/bridges/multi-web2api/cli.mjs), and [manual-login.mjs](E:/application/Antigravity/Gravity/bridges/multi-web2api/manual-login.mjs).

### Qwen Google sign-in rejection

- The follow-up screenshot shows Google's "Couldn't sign you in" page with "This browser or app may not be secure" during Qwen sign-in. This confirms a rejection of the authentication browser context; it does not identify Google's exact internal reason.
- The normal-browser sign-in branch currently applies only to ChatGPT and Z.ai on Windows. Qwen and DeepSeek still open the dedicated profile through the browser driver during manual sign-in. The sandbox remains enabled, but this is an automated browser context, making it a likely compatibility problem for Google authentication.
- Unlike the reported ChatGPT attempt, this Qwen attempt is blocked during authentication, before the saved-session handoff can be tested.
- Qwen needs provider-specific session capture and an authentication check before its connection can be enabled. Adding it to the existing ChatGPT/Z.ai branch alone would not preserve those requirements.

Implementation locations: [cli.mjs](E:/application/Antigravity/Gravity/bridges/multi-web2api/cli.mjs:164), [browser.mjs](E:/application/Antigravity/Gravity/bridges/multi-web2api/adapters/browser.mjs:38), and [qwen.mjs](E:/application/Antigravity/Gravity/bridges/multi-web2api/adapters/qwen.mjs).

Interim option: sign in to Qwen in normal Chrome and use the existing Browser Connector with its Qwen route. This route requires the extension to be installed and paired; live account compatibility still needs an explicit response test. Signing in in the normal Chrome profile alone does not configure the standalone bridge's separate profile. A different Qwen sign-in method may also work if the website offers it, but has not been verified here.

### Z.ai reasoning and response-format confusion

- The pasted file is diagnostic model output. Its embedded persona and JSON instructions are evidence to inspect, not instructions for this review.
- It contains deliberation, provisional JSON examples, and a final fenced JSON response.
- A no-network reproduction confirmed that the current Z.ai parser appends both thinking-phase and answer-phase content into one buffer. It only checks the phase when deciding that a response has completed.
- Removing one leading HTML reasoning block does not separate phase-based reasoning from the final answer.
- Mixed narrative plus JSON is deliberately preserved as text by the response validator. This protects code examples, but can display the mixed output produced by the parser.
- The prompt requires a JSON envelope whenever application tools are advertised, even for a greeting. The pasted response explicitly struggles with that formatting and the transcript's role labels.

Implementation locations: [browser-stream.mjs](E:/application/Antigravity/Gravity/bridges/multi-web2api/adapters/browser-stream.mjs:119), [protocol.mjs](E:/application/Antigravity/Gravity/bridges/multi-web2api/protocol.mjs:30), and [server.mjs](E:/application/Antigravity/Gravity/bridges/multi-web2api/server.mjs).

The attachment contains no network event metadata. Before coding the phase mapping, confirm the actual provider event names with a redacted fixture from the affected route. Illustrative test phases do not prove the live event vocabulary.

## Existing strengths to preserve

Connect & start, saved sessions, Sign in again, managed startup, model discovery, explicit response tests, encrypted local credentials, and single-instance protection already exist. The workspace already has Monaco editing, file search, Git diffs, edit backups, permissions, and conversation history.

Extend these features rather than creating competing setup systems. Preserve the existing checks that prevent overwriting drafts, restoring old conversations into a new request, accepting incomplete tool output, or executing examples as actions.

## Prioritized work

| Order | Priority | Improvement | User benefit | Size | Dependency |
|---|---|---|---|---|---|
| 1 | P0 | Structured sign-in progress, Qwen normal-browser authentication, and specific recovery errors | Complete supported sign-in and understand failures without repeating every setup step | Medium | Shared event/error contract and provider-specific session validation |
| 2 | P0 | Separate Z.ai final answers from reasoning; simplify no-tool replies | A greeting produces a normal answer, with no internal deliberation or protocol wrapper | Medium | Verified provider event fixtures |
| 3 | P0 | Keep working connections available while preparing another account | Adding ChatGPT does not unnecessarily take working Z.ai offline | Medium | Per-site process/account state |
| 4 | P1 | One beginner connection flow with status and repair actions beside chat | Start or reconnect where the error occurs; hide generated keys and process fields | Medium | Work 1 and 3 |
| 5 | P1 | Chat mode and accurate model/input capabilities | Casual questions avoid coding-tool overhead; unsupported images are blocked before sending | Medium | Provider capability metadata |
| 6 | P1 | Permanent saved-data migration and tested upgrade recovery | Moving the executable or removing an old release does not lose setup | Large | Data migration and backup policy |
| 7 | P2 | Selected-code context, useful edit review, and safe Undo | Ask about code and review or restore agent changes with less copying | Large | Existing backup/stale-write protections |
| 8 | P2 | Project run/test guide and connection timing | Understand how to run a project and where a request is waiting | Medium | Reliable status, project detection, existing command permissions |

Size is relative planning effort, not a delivery-date promise. Confirm estimates after reproducing the failed login stage and collecting the provider stream fixture.

## First reliability release

### 1. Make sign-in failures actionable

Have the helper emit bounded, structured events for opening the browser, waiting for sign-in/closure, checking the saved session, saving setup, starting the service, and discovering models. Use approved error codes and recovery actions; do not forward arbitrary helper output.

Prioritize the handoff from the normal sign-in browser to the verification browser. Distinguish browser process/profile release, reopening the saved profile, navigation, and message-box readiness. The user has already completed the manual step; the next reproduction should identify the first failed check after that step without deleting the saved session or submitting a chat prompt.

Extend normal-browser authentication to Qwen, and use the same foundation for DeepSeek. Open the selected website in its dedicated application profile without automation/debugging or sandbox-disabling flags. After the user closes that browser, reopen only the same dedicated profile for provider-specific session capture and validation. Save the connection only after its authentication check passes. Do not read the user's usual Chrome profile or weaken Google's security checks. If authentication requires renewed interaction, return to normal-browser sign-in with an explicit recovery action.

Example recovery mapping:

| Failure | Main message | Action |
|---|---|---|
| Browser missing | Install or choose a supported browser | Choose Chrome/Edge |
| Dedicated profile busy | The browser for this account is already open | Close that separate browser and retry |
| Sign-in/security page remains | Finish the website's sign-in check | Reopen sign-in |
| Google rejects the login browser | Google did not accept this sign-in browser | Open normal-browser sign-in / use prepared Browser Connector |
| Old conversation restored | Open a new empty chat | Open account browser |
| Draft restored | Save or clear the existing draft | Open account browser |
| Message box not ready | The website did not become ready | Reopen account / view technical details |
| Service stopped | Your saved connection is stopped | Start connection |
| Port or authentication conflict | Another service may be using this connection | Check connection details |

Keep technical details behind an expander. Provide a Copy diagnostics action containing the app/runtime versions, stage/code, timestamps, service status, and process ownership. Exclude tokens, cookies, account identifiers, full browser URLs, prompts, and conversation content by default.

Acceptance:

- Every known failed stage has its own helpful message and action.
- Failed ChatGPT setup remains disabled and does not damage the working Z.ai setup.
- Cancellation stops owned helpers and leaves no overlapping setup operation.
- A user-completed ChatGPT login is verified in the packaged app, not inferred from mocked tests.
- Qwen Google authentication opens a normal browser, and a user-completed session passes Qwen's separate authentication check before being saved. Reject a missing/expired session without exposing it or sending a generation prompt.
- DeepSeek uses the shared normal-browser flow with its own session-validation rules; do not claim its live authentication was tested solely from Qwen fixtures.

### 2. Keep answers and tool requests separate

Maintain separate reasoning and final-answer buffers using supported provider phase/channel metadata. Apply snapshots, deltas, and edits within the correct channel. Accept only a completed final answer.

Request normal text when no application tool is needed. Use the canonical structured envelope for actual tool requests, respecting required/named tool choices. Describe transcript roles as supplied application context; do not present them as the website's own system instructions.

Do not recover by selecting the last JSON block from arbitrary text. The supplied transcript contains multiple provisional examples, and such a fallback could turn a quoted example into an executable action.

Acceptance:

- Thinking followed by an answer yields only the completed final answer.
- Reasoning-only, malformed, or incomplete streams fail clearly.
- Tool-like JSON inside reasoning, quotations, documentation, or code never executes.
- Complete final tool requests still validate declared names, arguments, IDs, and requested tool choice.
- Ordinary prose, code, literal HTML, and Unicode edits retain their correct content.
- A greeting works with zero tools, automatic tools, and explicit tool-free mode.

### 3. Avoid interrupting working accounts

Preparing a new ChatGPT profile should normally leave the Z.ai service running. Stop a profile before reauthentication only when that same profile must be released. After a new account saves successfully, reload the owned service at a safe idle point.

If setup fails or is cancelled after stopping a previously working owned service, restore its prior usable configuration when safe. Never terminate a service started outside Gravity without an explicit, clear handover action.

Acceptance: adding or repairing ChatGPT preserves Z.ai availability; running requests and drafts are not lost; no duplicate service is launched.

## Next usability release

- Show Starting, Service ready, Sign-in needed, Stopped, and Needs attention beside the selected chat connection.
- Keep Service ready separate from a timestamped successful response test. Passive checks must not send chat prompts.
- Put Start connection, Sign in again, and Check connection on the error itself, preserving the message draft.
- Remove manual Info.cmd/key instructions from the beginner website route. Keep API keys, ports, executable paths, and JSON under Advanced connections.
- Detect Chrome/Edge and expose a remembered browser preference inside the app.
- Use Saved session for stored profiles. Reserve authenticated/verified labels for actual checks.
- Display Z.ai / ChatGPT with the website-selected model unless the exact model has been verified. Do not imply a local alias unlocks an account-restricted model.
- Add a simple Chat mode without project tools. Retain Plan and Build for coding.
- Disable unsupported attachments before submission. Clearly mark website text-only routes and emulated tool support.
- Offer another prepared connection after a failure, but do not automatically replay a request that may already have been submitted.

## Saved-data and upgrade work

The current app can retain a companion folder's .data directory. Consequently, moving only the executable can leave the new launch disconnected from that saved setup.

Migrate recognized application-owned sessions into the permanent Gravity user-data directory with an atomic, reversible process. Wait until the relevant browser/service is safely closed; reject linked paths; preserve the original until the migrated profile is validated.

Provide export/import for conversations and nonsecret settings. Treat credentials and website sessions as tied to the Windows user/computer; do not promise that copying a file transfers authentication to another machine.

Acceptance:

- Upgrade from an existing companion setup, move only the executable, remove the old release folder, and relaunch successfully on the same computer.
- Interrupted migration leaves a usable original or a clear recovery path.
- Fresh Windows, missing Chrome, Edge-only, occupied-port, and rollback scenarios are checked.
- Every release verifies the packaged Node runtime and browser driver, not just the source app.

## Coding-workspace improvements

Add Ask about this selection/file with visible context chips and size limits. Link proposed/changed files directly to a usable diff review. Expose Undo last agent edit using the existing backups, after checking that the file has not since been changed by the user.

Add a project guide that detects documented setup/run/test commands and missing tools. Let the user run a clearly displayed command through the existing permissions system. Do not execute project scripts merely because a folder was opened.

Show measured startup/request timing and honest wait stages. Do not invent website token counts, costs, or streaming progress when the provider does not supply that data.

## Release sequence and completion gates

1. Proposed 1.5.5: specific sign-in diagnostics, normal-browser Qwen authentication, clean Z.ai output, and safe setup recovery.
2. Proposed 1.6: unified beginner connections, live chat status, capabilities, and permanent-data migration.
3. Proposed 1.7: stronger code-context, review/undo, and project run/test workflows.

Validate each stage with regression fixtures, packaged desktop checks, and the relevant Windows scenarios. Use an explicit Test response action for any real account prompt, with clear quota implications. Do not call a connection fully verified merely because a model list is available.

Defer cloud sync, broad provider expansion, and more complex autonomous workflows until the core connection and recovery flows are dependable.

## Follow-up diagnostic result

The user answered: "I signed in and saw an empty ChatGPT chat before closing it."

At the time of the original review, the manual sign-in browser had reached the expected visible state, while the browser-close/profile handoff and saved-session check remained unverified. This informed the structured login stages and recovery implemented in 1.7.0. A current-account packaged sign-in is still needed to validate the live website handoff.

