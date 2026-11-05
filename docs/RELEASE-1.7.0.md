# Gravity 1.7.0

This release implements the functionality in the 5 November improvement plan in one package. It includes the earlier 1.5.4 one-click website service and its bundled Node/browser driver.

## Website connections

- ChatGPT, Z.ai, Qwen and DeepSeek sign-in opens normal Chrome or Edge in a dedicated application profile. Close that browser after signing in; Gravity continues automatically.
- Browser choice is remembered. Choosing another browser for a new account preserves earlier account browser preferences.
- Changing setup pages shares any pending browser check. Connect waits for it safely, and cancellation or app closure stops that wait.
- Progress identifies browser opening, closure, saved-session verification, service startup, and model discovery. Errors carry a fixed recovery code and action; technical diagnostics exclude account identifiers, prompts, cookies, tokens and private URLs.
- Preparing another account preserves working accounts. Reload waits for existing chats to finish, cancellation clears deferred work, and a failed owned-service reload restores the prior configuration where safe.
- Z.ai response handling separates reasoning wrappers verified in the pinned provider implementation from final answers. Code, quoted JSON and ordinary HTML remain text; unknown content channels fail clearly. Tool execution still requires a complete validated envelope.
- Greetings and ordinary replies use text. Structured output is requested when an application tool is actually needed.

## Chat and setup

- A focused desktop layout uses a compact project/session sidebar, a centered conversation and smaller composer. Neutral light/dark themes, simple starter actions and a direct Connections shortcut replace repeated welcome/status information. The layout is inspired by [OpenCode's desktop workflow](https://opencode.ai/).
- Connection details and completed-request timing expand on demand. Sign-in failures, recovery actions, image limits and running progress remain visible. Large text and the 980 × 640 minimum window were visually checked.
- New chats default to Chat mode with no project tools. Plan inspects and plans; Build uses the existing action permissions.
- The selected connection shows readiness, recovery actions, prepared alternatives, text/image support, and actual request timing. Service readiness is separate from a timestamped successful response test.
- Unsupported website images are blocked before submission. Changing connections and recovery preserve the draft; requests are never replayed automatically.
- Advanced adapter paths, keys, ports and JSON are collapsed beneath the beginner setup route. Website models are labelled as website routes rather than promises of exact model versions.

## Saved data and workspace

- Recognized legacy companion profiles move into permanent app data after their browsers and services release them. Files are checked and published atomically; originals remain for rollback. Busy, interrupted, or corrupt migrations have a recovery action and do not select partial copies.
- Export/import saves conversations and nonsecret API configuration. Imported chats use Ask permissions, without executable approvals, API history, pairing keys, or local service configuration. Authentication on another Windows account/computer requires setup again.
- Ask about file/selection attaches visible, bounded saved-file references. The backend rereads them in the selected project at submission.
- Changes has per-file Git and agent review. Undo verifies the recorded agent edit and refuses to replace subsequent user edits. Removed new files remain in protected backups.
- Project run/test guidance reads manifests/documented commands and checks installed tools. It fills a visible command for the user to run; opening a project does not run its scripts.

## Upgrade

1. Close the old Gravity app. Finish or stop its chats first.
2. Open `Gravity-1.7.0-x64.exe` from the release folder.
3. Open Settings → Get started to connect or repair a website.
4. For pending saved-data migration, close the separate account browsers and stop any externally started service, then use Settings → Appearance → Migrate saved website data. Gravity can stop and restart its own idle service during migration.
5. Keep the old companion folder until migration succeeds. An external service is never terminated automatically.
6. If you use Browser Connector, choose Open extension setup and Reload the existing Gravity extension in Chrome to activate the updated prompt formatting.

For the optional included Claude Python bridge, follow [the Windows guide](CLAUDE-WEB2API-WINDOWS.md). That bridge remains separate from the executable and the Chrome extension route.

## Validation limits

The final automated suite passed 339 tests, including a disposable-fixture check that named cookie exports are excluded from the source distribution. Native desktop smoke covered default Chat, saved-line contexts and stale-context rejection, actual request timing, website image rejection, safe diagnostics, proposal/apply/review/Undo, passive project guidance, one-click startup, credentials, connection switching, permissions and browser pairing. Eighteen isolated Electron DOM checks covered the six website adapters and guarded failure/cancellation cases. The desktop screenshots were visually inspected.

The portable executable also passed an isolated launch from a folder with spaces with developer runtimes removed from PATH. Its bundled website service connected without companion files, system Node, live website traffic or inference; local authentication, encrypted provider keys, automatic startup and saved preferences were checked.

These fixtures do not substitute for current ChatGPT/Qwen/DeepSeek/Z.ai or Claude account authentication and generation tests, or a fresh Windows virtual machine. Use the explicit Test response button to verify an account; it consumes website quota. Website sign-in/security checks remain user actions.
