# Gravity standardization from OpenCode

Reviewed on **5 November 2026** against the public [anomalyco/opencode repository](https://github.com/anomalyco/opencode), default branch `dev`, at commit [`d0045aaab5872df54da8723a6c43453b61e1ee90`](https://github.com/anomalyco/opencode/tree/d0045aaab5872df54da8723a6c43453b61e1ee90).

This is a selected-source review of desktop file access, composer attachments, project selection, health, session execution, permissions and IPC architecture. It does not establish full OpenCode parity or review every source file. The recommendations adapt public design patterns to Gravity's existing Electron/React application; they do not require copying OpenCode code or changing frameworks.

## Standards and Gravity mapping

| Reviewed OpenCode pattern | Gravity standard | Source |
| --- | --- | --- |
| Separate directory picking from attachment picking; authorize selected files for the requesting renderer and clear access on navigation or closure | **Open folder** selects a project. The composer **+** attaches explicitly selected files through native IPC, without granting a new workspace | [Native picker](https://github.com/anomalyco/opencode/blob/d0045aaab5872df54da8723a6c43453b61e1ee90/packages/desktop/src/main/files/attachment-picker.ts), [picker lifecycle](https://github.com/anomalyco/opencode/blob/d0045aaab5872df54da8723a6c43453b61e1ee90/packages/desktop/src/main/files/attachment-picker-machine.ts), [file IPC](https://github.com/anomalyco/opencode/blob/d0045aaab5872df54da8723a6c43453b61e1ee90/packages/desktop/src/main/ipc-handlers/files.ts) |
| Attachment work belongs to its originating draft; pending uploads, cancellation and errors are explicit; picker, paste and drop share a pipeline | Preserve the correct draft during asynchronous selection, show accepted/rejected files, and enforce the selected model's capabilities before sending | [Attachments](https://github.com/anomalyco/opencode/blob/d0045aaab5872df54da8723a6c43453b61e1ee90/packages/app/src/composer/attachments/attachments.ts), [draft destination](https://github.com/anomalyco/opencode/blob/d0045aaab5872df54da8723a6c43453b61e1ee90/packages/app/src/composer/attachments/destination.ts), [prompt parts](https://github.com/anomalyco/opencode/blob/d0045aaab5872df54da8723a6c43453b61e1ee90/packages/app/src/composer/prompt-parts.ts) |
| Successful directory selection updates both known projects and the active draft's project/server/worktree | A newly chosen Gravity project becomes the active project immediately; opening a folder runs no project command | [Project controller](https://github.com/anomalyco/opencode/blob/d0045aaab5872df54da8723a6c43453b61e1ee90/packages/app/src/new-session/project/controller.ts), [selector](https://github.com/anomalyco/opencode/blob/d0045aaab5872df54da8723a6c43453b61e1ee90/packages/app/src/new-session/project/selector.tsx) |
| Health distinguishes checking, starting, authentication, compatibility and reachability; stale probe attempts are ignored | Keep service health, account readiness and timestamped response-test results separate. A failed request needs its own visible recovery state | [Health machine](https://github.com/anomalyco/opencode/blob/d0045aaab5872df54da8723a6c43453b61e1ee90/packages/app/src/runtime/server/health-machine.ts) |
| Runs serialize per session while independent sessions can proceed; cancellation has explicit settlement and ownership | Bound recovery waits, cancel owned work, preserve the draft and avoid automatically replaying a prompt that may already have reached the website | [Run coordinator](https://github.com/anomalyco/opencode/blob/d0045aaab5872df54da8723a6c43453b61e1ee90/packages/core/src/session/run-coordinator.ts) |
| Permission requests refer to the session and tool invocation; allow/ask/deny decisions and failures are typed | Continue enforcing permissions in Gravity's backend. Attachments supply read-only data; they do not authorize tools to read or modify their original folder | [Permissions](https://github.com/anomalyco/opencode/blob/d0045aaab5872df54da8723a6c43453b61e1ee90/packages/core/src/permission.ts), [session errors](https://github.com/anomalyco/opencode/blob/d0045aaab5872df54da8723a6c43453b61e1ee90/packages/core/src/session/error.ts), [messages](https://github.com/anomalyco/opencode/blob/d0045aaab5872df54da8723a6c43453b61e1ee90/packages/core/src/session/message.ts) |
| Desktop OS services, shared IPC schemas, UI and core session logic have explicit boundaries and cleanup | Strengthen Gravity's existing native, renderer, agent, workspace and bridge boundaries incrementally; centralize shared contracts | [Desktop services](https://github.com/anomalyco/opencode/blob/d0045aaab5872df54da8723a6c43453b61e1ee90/packages/desktop/src/main/desktop.ts), [IPC](https://github.com/anomalyco/opencode/blob/d0045aaab5872df54da8723a6c43453b61e1ee90/packages/desktop/src/main/ipc.ts), [shared contracts](https://github.com/anomalyco/opencode/blob/d0045aaab5872df54da8723a6c43453b61e1ee90/packages/desktop/src/shared/ipc-rpc.ts) |

OpenCode's reviewed native picker uses a 20 MiB selection budget and a renderer-scoped token. Its composer can use native image/PDF parts or path/staged attachments according to capabilities and destination. Gravity deliberately uses narrower formats and bounded text snapshots because a standalone attachment must not extend its agent's project access.

## Applied in the current Gravity source

These describe the current implementation prepared for the follow-up release. Release validation and packaged-app results belong in the release notes; this document alone does not establish that those checks passed.

- **A dedicated + file picker.** Native multiple-file selection returns opaque IDs for text/code files. No project is required. Cancellation leaves the current draft intact, late results are discarded if the originating draft changed, and rejected selections produce actionable messages.
- **Bounded file handling.** Up to four UTF-8 text/code files and eight supported images can be attached. Text files are limited to 40 KiB and 500 lines each, within the agent's combined 60,000-character text/context budget. Images are PNG, JPEG, WebP or GIF, with an 8 MiB limit per image and 24 MiB combined encoded budget; the selected connection must accept images.
- **Explicit access and snapshot semantics.** Native selection is the only source of text-file authorization. Reads reject folders, links/redirects, oversized files, binary data and invalid UTF-8. Text file identity is checked while reading, and SHA-256 is checked again before sending. Images are signature-checked and captured as bytes during selection. Text snapshots are saved with the message as read-only context, without adding workspace authority. Outstanding text IDs are bounded and cleared on renderer navigation.
- **Correct project selection.** Workspace's **Open folder** now uses the root project callback and selects the returned project, matching the successful selection behavior of the main project flow.
- **Honest connection feedback.** A failed request remains visible beside the composer even when the local service is running. Known sanitized error codes provide useful recovery actions; arbitrary provider output does not become the user-facing error message.
- **Bounded ChatGPT verification.** Security verification waits use one owned browser and a bounded wait. Recovery offers normal Chrome sign-in while retaining the browser sandbox. Cancellation and browser/profile ownership remain explicit.

Main Gravity boundaries remain `src/` for UI, `electron/main.mjs`/preload for native IPC, `electron/store.mjs` for persistence, `electron/agent.mjs`/`permissions.mjs`/`workspace.mjs` for agent actions, and `electron/managed-bridges.mjs`/`web2api-setup.mjs` plus `bridges/` for managed services and providers. Existing Chat/Plan/Build modes and Ask/Auto edits/Full permission controls remain the user-facing model.

## Acceptance checks

Use isolated temporary profiles and fixture providers for automated checks. Record live account checks separately.

| Area | Required outcome |
| --- | --- |
| Picker cancellation | Clicking + then cancelling retains the draft and previous attachments; it neither creates a project nor sends a request |
| Standalone attachments | With no active project, a supported UTF-8 file attaches, appears in the outgoing read-only context and survives in saved message history |
| Mixed selections | Supported selections remain usable while PDF/Office/ZIP, binary, unreadable or invalid files receive clear individual errors |
| Size and format limits | File counts, bytes, lines, combined context and image budgets are enforced in the backend; images with mismatched signatures are rejected |
| Changed or expired selections | A changed/deleted text file fails before provider submission; arbitrary or expired IDs fail; renderer navigation clears outstanding authorization |
| Permission boundary | A file attached outside the project does not permit agent reads, edits or commands in its containing folder |
| Image capability | A text-only connection cannot send images; changing connection before sending repeats capability validation |
| Project selection | Open folder both adds and activates the selected project; cancelling leaves the current project selected |
| Failure feedback | A running service does not hide a failed request. Known recovery codes have actionable messages, without raw provider output, tokens or browser URLs |
| Verification and cancellation | Security verification opens no overlapping recovery browsers, waits within its bound, cleans up owned work on cancellation and preserves working account setup |
| Prompt ownership | Recovery preserves the user's draft and does not silently resubmit a previously attempted prompt |

For the live ChatGPT check, the user completes any website challenge in the browser, then explicitly tests a response. A listening local server or successful model discovery does not prove account generation works. Repeated challenges can depend on website/account policy and browser/session state; automated fixtures cannot guarantee that the website will stop requesting them.

## Next implementation priorities

| Priority | Work | Completion standard |
| --- | --- | --- |
| P1 | Shared IPC and recovery contracts | Define request/response schemas and a central sanitized error-code registry consumed by native handlers, bridges and UI; reject malformed input at the native boundary |
| P1 | Draft persistence and unified attachment handling | Build on the picker destination guard to persist drafts by conversation; converge picker, paste and drop on one validation pipeline with explicit pending/cancelled/failed states |
| P1 | Explicit service/setup/request transitions | Give each attempt an identity, ignore stale results, show account and request state independently, and settle cancellation once |
| P2 | Bounded PDF/Office extraction | Add supported parsers, per-document/page/byte limits, cancellation and visible extraction errors; distinguish extracted text from native document inputs based on model capabilities |
| P2 | Broader workspace and tooling consistency | Extend the existing review/Undo, project guidance and permission flows with shared session/tool contracts before adding more autonomous tools |

PDF/Office extraction, unified paste/drop, persistent drafts, a complete typed IPC migration and a broad architecture rewrite are future work in this comparison. OpenCode's package structure is a useful reference, not a requirement to replace React with Solid/Effect or JSON persistence with SQLite.

## Review limits and related guides

Only public repository source was used for this comparison. No private OpenCode internals or user account data were inspected, and no CAPTCHA bypass, automated solving, stealth configuration or sandbox disabling is part of the standardization.

The reviewed `dev` commit is the source of the architectural claims above. The official [permissions documentation](https://opencode.ai/docs/permissions/) includes version-specific OpenCode 1 material and should not be assumed to describe every aspect of this reviewed development implementation.

See the [existing improvement plan](IMPROVEMENT-PLAN-2026-11-05.md) for the earlier release's completed work and validation, [setup guide](SETUP.md) for user instructions, and [included Claude Web2API guide](CLAUDE-WEB2API-WINDOWS.md) for the optional Claude bridge.
