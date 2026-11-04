# Use website accounts from Chrome

Gravity 1.5.2 includes an original Chrome companion extension for Claude, ChatGPT, DeepSeek, Qwen, Z.ai, and Gemini. It uses the Chrome profile where the extension is installed. Existing website logins stay in Chrome; no Python, Git, configuration editing, cookie exports, or website API keys are needed for this connection method. See [system requirements](SYSTEM-REQUIREMENTS.md) for platform and task-specific dependencies.

The extension drives the website's visible chat interface. These are experimental website adapters, not official model APIs. They have been tested with local fixtures; live compatibility with each current website and your account must be checked separately. If a layout or completion control changes, the connector reports a failure instead of fabricating an answer or returning partial text as complete.

## One-time Chrome setup

1. Open Gravity and go to **Settings → Browser Connector**. The connector starts with the app and creates a **Browser Connector** provider and all six website routes automatically. Older profiles may retain the provider name **Connected Chrome**.
2. Click **Open extension setup**. The app opens Chrome's extensions page, reveals the prepared extension folder, and copies its path to the clipboard. In Chrome, enable **Developer mode**, select **Load unpacked**, and select that folder. Chrome requires the user to permit this installation; the desktop does not silently change Chrome policies or install extensions.
3. Open **Gravity Browser Connector** from Chrome's extensions menu and click **Connect to app**. Return to the desktop app and approve the matching extension request. The popup and desktop display the extension identity; approve a request you just initiated.
4. Keep a signed-in tab open for each website you want to use. Use **Test response** on its desktop website card to verify a completed text reply, then select **Use in chat** or choose its browser model in your conversation. Use the extension's site refresh if a login has just completed.

Upgrading from an older version requires updating the unpacked extension as well as the desktop. Follow the [Gravity upgrade steps](RELEASE-1.5.2.md). Open extension setup updates recognized old install folders; click **Reload** in Chrome to activate those files, even if they have already been updated on disk. The active extension version is always visible beside the connector status once it connects. Gravity 1.5.2 uses a protocol 3 handshake with extension 1.0.5 and blocks an outdated active extension before a prompt is submitted.

No repeated cookie copying is needed. Approved pairing is saved with Windows encryption and reused after normal app and connector restarts. Reconnect and approve only after access is revoked or the extension's stored data is cleared. Website sessions remain in Chrome. Revoking access immediately cancels pending browser jobs. You can use the existing Gemini executable or other direct API bridges alongside this method.

| Website | Desktop model route | Chrome website |
| --- | --- | --- |
| Claude | `claude-web` | `https://claude.ai/` |
| ChatGPT | `chatgpt-web` | `https://chatgpt.com/` |
| DeepSeek | `deepseek-web` | `https://chat.deepseek.com/` |
| Qwen | `qwen-web` | `https://chat.qwen.ai/` |
| Z.ai | `zai-web` | `https://chat.z.ai/` |
| Gemini | `gemini-web` | `https://gemini.google.com/` |

These routes select a website. They do not select or attest to a particular underlying model version. Choose a model using the website's own controls; available choices depend on your account and the site's new-chat defaults. A detected tab/composer is not proof of a valid session or successful generation.

## What happens when you send a message

The desktop queues one request per website. The extension opens a fresh task tab in the signed-in Chrome profile, checks that it is an empty new-chat page, enters the supplied conversation context, and submits the prompt. It returns only a new assistant response with an observed completion signal. Successful task tabs close; failed tabs remain for inspection. The website may retain the new conversation in its history.

Existing conversations, restored drafts, login/password forms, and challenges are not modified. If the site restores an existing conversation instead of opening a fresh one, the connector refuses to send. If you interact with a task tab, the task stops. Sign-in, verification, account upgrades, and model selection remain user actions. There is no challenge bypass or password automation.

Text messages are supported. Images, attachments, native website tools, and exact token accounting are outside this connection method. The extension returns the raw completed reply, and the desktop parses it once. Tools requested by the desktop agent use a constrained JSON text format and still pass through the desktop's permission checks. A text-only final reply with empty tool calls can be displayed even when website typography changes its quotes; malformed actions are never repaired into executable calls. Tool examples embedded in prose cannot trigger actions. Native API providers remain preferable when you need protocol-level tools, large contexts, or predictable streaming; browser responses are buffered until complete.

## Local connection and privacy

The connector listens on `127.0.0.1:4319`. The desktop-generated provider key and extension pairing key are separate. Website-origin requests cannot use the local API or pairing channel. The extension must be approved in the desktop before it can receive task prompts. Stop the connector or revoke the extension to disconnect it.

Host access is limited to the six websites and this loopback endpoint. The extension does not request cookie access, general browsing-history access, debugger access, native messaging, or all-sites permissions. It does not export Chrome cookies, read passwords, inspect website storage, call private website APIs, or import old chat history. It stores its connector pairing token in extension storage; Gravity stores the matching approval encrypted in the active Windows profile. Requests and responses still go to the selected website, subject to that service's account and usage limits.

## Troubleshooting

- **Open extension setup appears inactive in an older release:** upgrade to Gravity 1.5.0; the prepared folder path and errors appear beside the button. You can also open `chrome://extensions/` manually and load the prepared folder.
- **The new chat tab did not finish loading:** Gravity waits for the chat input instead of Chrome's overall loading indicator. If it still fails, inspect the new failure tab for sign-in, verification, or an unsupported layout. No prompt is submitted when input readiness fails.
- **A greeting fails with “unstructured text”:** Gravity 1.5.1 could reject a harmless final reply containing empty `tool_calls`. Update to Gravity 1.5.2 and extension 1.0.5 using the [upgrade steps](RELEASE-1.5.2.md). The desktop now distinguishes a text-only reply from an action.
- **Extension update required:** check the active version beside the connector status. Choose **Open extension setup**, then click **Reload** on **Gravity Browser Connector** in Chrome. Updating its folder alone does not replace Chrome's running extension.
- **Tool-call JSON mixed with other text:** the bundled extension (1.0.5) requests a single fenced JSON block to preserve quotes and underscores. Hidden accessibility summaries and timestamps are excluded; malformed action text is reported as an error. A code example embedded in prose is never executed. A recurring format failure requires inspecting the complete assistant reply; account/project-list JSON is not that reply.
- **Cannot reach 127.0.0.1:4319:** start the Browser connector in the desktop. If the port is occupied, stop the other connector instance; the app never kills unrelated processes to reclaim a port.
- **Waiting for approval:** click Connect in the extension, then approve its matching request in the desktop.
- **Pairing revoked or extension data cleared:** connect and approve again.
- **No tab/composer:** open the website in the same Chrome profile, sign in yourself, and refresh the site status.
- **Existing conversation or draft:** the site restored content in the fresh tab. Open a clean new chat yourself and retry; the connector will not overwrite it.
- **No verified completion or changed layout:** inspect the failed task tab. A service adapter may need an update. A successful local test is not evidence of compatibility with every live website revision.

Tests use synthetic local pages and a simulated extension channel without accessing website accounts. Real signed-in Chrome checks remain a separate validation step after the extension has been installed.

## Discovery succeeds but Claude chat fails

The six browser model IDs are website routes. They can be listed even before an extension is paired or a website is ready. A conversation using a separate **Claude web2api** provider on port 8081 still sends requests to that separate server. Opening or testing Browser Connector in Settings does not switch the conversation.

Use **Use Claude in Chrome** above the failed conversation, or open **Settings → Models & providers → Browser Connector → Use in this chat** with default model `claude-web`. The connector and its approved extension reconnect after normal restarts. If pairing has been revoked, connect and approve again. Keep Claude open and signed in in the Chrome profile with the extension. **Test model** now checks readiness and a real text response.
