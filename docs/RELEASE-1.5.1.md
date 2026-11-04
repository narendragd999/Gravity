# Gravity 1.5.1 — browser action handoff

The browser could return an action as text containing a “Claude responded” accessibility summary, duplicated JSON, smart quotes, and a timestamp. Misspelled `toolcalls` or smart-quoted `tool_calls` were not detected, so the chat displayed them as a normal answer and never requested approval.

The extension now excludes hidden and screen-reader-only response duplicates and timestamps. It asks for one fenced JSON block so website typography does not alter JSON punctuation. The parser rejects malformed action markers without repairing or executing them. The desktop also rejects opaque action transcripts returned by older extensions. Windows agent instructions identify PowerShell and specify its syntax for multiple directory paths.

## Update both components

1. Close the old Gravity app and open `Gravity-1.5.1-x64.exe`.
2. Open **Settings → Browser Connector → Open extension setup**.
3. In `chrome://extensions`, click **Reload** on **Gravity Browser Connector**. Its version should be **1.0.4**. The existing pairing remains available.
4. Start a new Gravity conversation in your project and retry the folder request. With **Ask for approval**, review the command card and select **Run command**.

The screenshot's **API Offline** label is separate: browser chats use Browser Connector directly. That label reflects the local API gateway's saved startup preference. Enable **Settings → API → Start API when Gravity opens** if desired.

Validation covers the malformed response, decorated DOM extraction, and an end-to-end local fixture that waits for approval before creating both folders. The live Claude website has not been retested with the user's account.
