# DeepSeek, Qwen, ChatGPT, and Z.ai

Gravity 1.7.0 includes these four website adapters and their runtime in the desktop executable. They do not use the Browser Connector extension. DeepSeek/Qwen use direct authenticated HTTPS; ChatGPT/Z.ai submit through dedicated website profiles and capture network SSE.

1. Open **Settings → Get started** or **Web2API Bridges**.
2. Choose a website and click **Connect & start**.
3. Sign in in the separate Chrome/Edge window, open a new empty chat, and **close that separate browser**. Gravity continues automatically for all four websites.
4. Click **Test response** once the service is ready, then **Use in this chat** if needed.

No extension, pasted key, exported cookie, or manual process setup is needed. Install Chrome or Edge and complete website security checks yourself. Saved sessions are reused and the configured service starts with Gravity. Service readiness does not prove generation; **Test response** sends a real short message and uses account quota. Live compatibility remains an account-specific check.

The desktop stores website data in its permanent user-data folder. Recognized older companion sessions migrate when their browsers and service are closed; keep the old folder until migration succeeds. See [Windows setup and recovery](../bridges/multi-web2api/WINDOWS.md).

## Advanced standalone service

The same bridge can run independently at `http://127.0.0.1:4320/v1` with its own generated local token and private `.data/` directory. A separately prepared `Gravity-Web2API` companion provides bundled Node and double-click launchers. See [source installation, model discovery, API details, and tests](../bridges/multi-web2api/README.md). Do not run an external and desktop-managed copy on the same port.

From the root, `npm run web2api:setup`, `npm run web2api:accounts`, `npm run web2api:info`, `npm run web2api:models`, and `npm run web2api:probe -- <alias>` wrap the bridge CLI. Install its dependency with `npm ci --prefix bridges/multi-web2api`. Existing `npm run web2api -- --config <file>` remains the separate universal gateway.

Normal OpenAI-compatible APIs already accept arbitrary provider model IDs in Gravity. Website bridges expose configured/advertised website aliases; arbitrary names cannot create model access. Link separately prepared Gemini/Claude and this service using advanced managed profiles or the [universal service](UNIVERSAL-WEB2API.md). Standalone CLI commands do not import desktop settings; the beginner desktop connection flow saves its connection automatically.
