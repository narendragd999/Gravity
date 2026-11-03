# Antigravity Studio 1.4.1

Released 3 November 2026 for Windows x64.

## Connection fixes

- **Test model** now sends a small text request to the selected saved model. A model list alone cannot produce a successful result. The result identifies the provider, endpoint, and model tested.
- Browser model tests check connector startup, extension pairing, and the selected website tab before attempting generation.
- Settings opens on the current conversation's provider. **Use in this chat** applies another saved provider and its default model while preserving the conversation.
- The chat shows its provider and model. Failed local Claude connections offer **Use Claude in Chrome** when the browser provider is configured.
- Discovery describes its result as model IDs or website routes; it does not imply generation readiness.

## Upgrade and recover the Claude conversation

1. Close the old Antigravity Studio app and open `Antigravity-Studio-1.4.1-x64.exe`. The new version uses the same saved projects, providers, and conversations.
2. Open **Settings → Web2API bridges**, start the browser connector, connect the installed extension from its Chrome popup, and approve its request in the desktop. Open Claude and sign in in that Chrome profile. Pairing must be repeated after restarting the connector.
3. Open the failed conversation and click **Use Claude in Chrome**. Alternatively, select **Connected Chrome** in **Models & providers**, set/save `claude-web` as the default model, and click **Use in this chat**. Send your message again.

**Why the old messages conflicted:** `Connected Chrome` lists six website routes at `http://127.0.0.1:4319/v1`. The failed conversation used the separate `Claude web2api` provider on port 8081, where no server was running. Saving or testing a different provider did not change that conversation's selection. The standalone Python Claude project defaults to port 8082 and needs separate setup; changing the port alone does not start it.

Use **Test model** in Settings to send a short diagnostic message. The test can consume provider quota or create a message in website history. It sends no project files, conversation history, or tool definitions. Successful text generation does not establish tool-call support or guarantee later requests.

The Chrome adapters still depend on website layouts, sign-in, and account availability. See [validation results](VALIDATION.md) for what was tested with local fixtures.
