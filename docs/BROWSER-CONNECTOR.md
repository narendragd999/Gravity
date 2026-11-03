# Use website accounts from Chrome

Antigravity Studio 1.4.3 includes an original Chrome companion extension for Claude, ChatGPT, DeepSeek, Qwen, Z.ai, and Gemini. It uses the Chrome profile where the extension is installed. Existing website logins stay in Chrome; no Python, Git, configuration editing, cookie exports, or website API keys are needed for this connection method. See [system requirements](SYSTEM-REQUIREMENTS.md) for platform and task-specific dependencies.

The extension drives the website's visible chat interface. These are experimental website adapters, not official model APIs. They have been tested with local fixtures; live compatibility with each current website and your account must be checked separately. If a layout or completion control changes, the connector reports a failure instead of fabricating an answer or returning partial text as complete.

## One-time Chrome setup

1. Open the 1.4.3 app and go to **Settings → Web2API bridges → Browser connector**. Click **Start browser connector**. The app creates a **Connected Chrome** provider and all six model routes automatically.
2. Click **Open extension setup**. The app opens Chrome's extensions page, reveals the prepared extension folder, and copies its path to the clipboard. In Chrome, enable **Developer mode**, select **Load unpacked**, and select that folder. Chrome requires the user to permit this installation; the desktop does not silently change Chrome policies or install extensions.
3. Open **Antigravity Studio Browser Connector** from Chrome's extensions menu and click **Connect to app**. Return to the desktop app and approve the matching extension request. The popup and desktop display the extension identity; approve a request you just initiated.
4. Keep a signed-in tab open for each website you want to use. Use **Test response** on its desktop website card to verify a completed text reply, then select its **Connected Chrome** model in your conversation. Use the extension's site refresh if a login has just completed.

Upgrading from an older version requires updating the unpacked extension as well as the desktop. Follow the [1.4.3 upgrade steps](RELEASE-1.4.3.md). Open extension setup now updates recognized old install folders; click Reload in Chrome to activate those files. A detected incompatible extension is blocked before any prompt is delivered.

No repeated cookie copying is needed. Pairing is held by the desktop process and expires when it stops; reconnect and approve after restarting the connector. Website sessions remain in Chrome. Revoking access immediately cancels pending browser jobs. You can use the existing Gemini executable or other direct API bridges alongside this method.

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

Text messages are supported. Images, attachments, native website tools, and exact token accounting are outside this connection method. Tools requested by the desktop agent use a constrained JSON text format and still pass through the desktop's permission checks. Tool examples embedded in prose cannot trigger actions. Native API providers remain preferable when you need protocol-level tools, large contexts, or predictable streaming; browser responses are buffered until complete.

## Local connection and privacy

The connector listens on `127.0.0.1:4319`. The desktop-generated provider key and extension pairing key are separate. Website-origin requests cannot use the local API or pairing channel. The extension must be approved in the desktop before it can receive task prompts. Stop the connector or revoke the extension to disconnect it.

Host access is limited to the six websites and this loopback endpoint. The extension does not request cookie access, general browsing-history access, debugger access, native messaging, or all-sites permissions. It does not export Chrome cookies, read passwords, inspect website storage, call private website APIs, or import old chat history. It stores its connector pairing token in extension storage; that token expires with the desktop process. Requests and responses still go to the selected website, subject to that service's account and usage limits.

## Troubleshooting

- **Open extension setup appears inactive in 1.4.1:** the packaged archive copy can leave an empty folder. Upgrade to 1.4.2; the prepared folder path and errors appear beside the button. You can also open `chrome://extensions/` manually and load the prepared folder.
- **The new chat tab did not finish loading:** 1.4.2 waits for the chat input instead of Chrome's overall loading indicator. If it still fails, inspect the new failure tab for sign-in, verification, or an unsupported layout. No prompt is submitted when input readiness fails.
- **Tool-call JSON mixed with other text:** update the extension to 1.0.1, which explicitly requests a whole-response JSON envelope. A code example embedded in prose is never executed. A recurring format failure requires inspecting the complete assistant reply; account/project-list JSON is not that reply.
- **Cannot reach 127.0.0.1:4319:** start the Browser connector in the desktop. If the port is occupied, stop the other connector instance; the app never kills unrelated processes to reclaim a port.
- **Waiting for approval:** click Connect in the extension, then approve its matching request in the desktop.
- **Pairing expired or revoked:** connect and approve again.
- **No tab/composer:** open the website in the same Chrome profile, sign in yourself, and refresh the site status.
- **Existing conversation or draft:** the site restored content in the fresh tab. Open a clean new chat yourself and retry; the connector will not overwrite it.
- **No verified completion or changed layout:** inspect the failed task tab. A service adapter may need an update. A successful local test is not evidence of compatibility with every live website revision.

Tests use synthetic local pages and a simulated extension channel without accessing website accounts. Real signed-in Chrome checks remain a separate validation step after the extension has been installed.

## Discovery succeeds but Claude chat fails

The six model IDs under **Connected Chrome** are website routes. They can be listed even before an extension is paired or a website is ready. A conversation using a separate **Claude web2api** provider on port 8081 still sends requests to that separate server. Opening or testing Connected Chrome in Settings does not switch the conversation.

Use **Use Claude in Chrome** above the failed conversation, or open **Settings → Models & providers → Connected Chrome → Use in this chat** with default model `claude-web`. Start the connector and connect/approve the extension again after an app restart. Keep Claude open and signed in in the Chrome profile with the extension. **Test model** now checks readiness and a real text response.
