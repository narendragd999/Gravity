# Gravity 1.5.2 — browser text replies

Gravity 1.5.1 could reject a harmless greeting as an unstructured action when the website returned a final reply with curly quotes and an empty `tool_calls` array. No command was requested in that response; the action-format guard was too broad.

Gravity 1.5.2 recognizes text-only final replies and displays their content. The extension returns the raw completed browser reply, and the desktop parses it once. Actual commands still require the expected structure and pass through the existing approval policy. Malformed nonempty actions and examples embedded in prose are never repaired into executable calls.

The desktop and extension now use a protocol 3 handshake. An outdated active extension is blocked before a prompt is submitted. Browser Connector settings show the version reported by the running Chrome extension beside the connector status, including when installation details are collapsed.

## Update both components

1. Close the old Gravity app and open `Gravity-1.5.2-x64.exe`.
2. Open **Settings → Browser Connector → Open extension setup** to prepare the bundled extension files.
3. In `chrome://extensions`, click **Reload** on **Gravity Browser Connector**. Chrome must reload the extension even if its files have already been updated on disk.
4. Confirm **Active Chrome extension: 1.0.5 · Compatible** in Gravity's Browser Connector settings, then retry the conversation. Normal saved pairing is retained.

Validation: 181 automated tests pass, including the reported smart-quoted greeting, malformed actions, duplicate fields, command approval, raw browser handoff, and stale extension rejection. The desktop smoke test passes the greeting through the real agent and connector with a simulated browser response; 18 isolated Electron DOM checks also pass.

The packaged executable also passes a portable launch check from a separate folder with spaces and no developer runtimes on PATH. Its API starts automatically and retains authentication and saved preferences.

Live Claude behavior with the user's account has not been verified. Computer-use could not verify Chrome's current URL and stopped the UI test before any reload or test message was submitted.
