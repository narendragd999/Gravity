# Gravity Web2API for Windows

## Recommended: use Gravity 1.7.0

The desktop executable includes this service, Node, and the browser driver. Install **Chrome or Edge**, then:

1. Open **Gravity-1.7.0-x64.exe**.
2. Open **Settings → Get started** or **Web2API Bridges**.
3. Choose **DeepSeek**, **Qwen**, **ChatGPT**, or **Z.ai** and click **Connect & start**. Choose a browser under **Browser for the next sign-in** if needed.
4. Sign in in the separate browser that opens. Complete the website's security checks yourself, open a **new, empty chat**, then **close all windows of that separate browser**. Gravity checks the saved session and continues automatically. These steps apply to all four websites.
5. When the service is ready, click **Test response** to verify a real answer. Choose **Use in this chat** if it was not already selected.

There are no keys, ports, JSON files, or terminal commands to fill in. Saved sign-ins are reused and the service starts with Gravity. **Test response** sends a short message and may use website quota; setup itself sends no prompt. A ready service is separate from a successful response test.

For later problems, select the website and use **Sign in again**, or follow the recovery action beside the error. **Connection details & diagnostics → Copy diagnostics** provides the failed stage and code without credentials or chat content.

Website data is stored in the permanent Gravity user-data folder. Recognized older companion sessions are migrated when their browsers and service are closed. Keep the original companion folder until migration succeeds; use **Settings → Appearance → Migrate saved website data** if it is pending. Authentication must be set up again on a different Windows account or computer.

## Advanced: run the companion service separately

Use these steps only if you want a standalone service outside the desktop. Keep the complete **Gravity-Web2API** folder in a writable, permanent location. It includes Node and playwright-core. No separate Node/npm installation or Gravity extension is needed. It does not need to sit beside the executable.

1. Double-click **Setup.cmd**. It creates a private `.data/config.json` and a generated local API key. All website adapters start disabled.
2. Run **Login-DeepSeek.cmd**, **Login-Qwen.cmd**, **Login-ChatGPT.cmd**, or **Login-Zai.cmd** for the websites you want. For every website, the launcher opens a normal installed browser in a separate bridge profile: sign in, complete security checks, open a new empty chat, **close all windows of that separate browser**, then **press Enter in the terminal**. The helper briefly reopens the profile to check readiness and saves it without sending a prompt. Saved sessions are reused. For installed Edge, change `browserChannel` to `msedge` in `.data/config.json` before the first login. To change an already configured site's browser, use the CLI login option `--browser msedge`.
3. Double-click **Start.cmd**. Leave its terminal open while using the service. It listens at `http://127.0.0.1:4320/v1` and never stops another service using that port.
4. Run **Info.cmd**. In Gravity, open **Settings → Models & providers → Add provider → Gravity Web2API**, paste the generated **local API key**, and save. Choose **Discover models**, save the returned list, then select that provider/model in your chat.
5. For automatic startup, stop the terminal service with Ctrl+C. Open **Settings → Web2API Bridges → Advanced adapter profiles & configuration → Add bridge**, select the saved provider, choose **Managed**, and copy the executable, arguments JSON, working directory, and health URL from Info.cmd. Choose **Save & start bridge** and enable **Start saved bridge profiles when Gravity opens**. Keep this companion folder at its saved path. Do not start a second copy through the beginner connection flow while this separate service is running.

DeepSeek/Qwen send direct HTTPS requests using the session captured during setup. Alternatively set `enabled: true` and a website `token` in the corresponding private config entry, or provide `GRAVITY_DEEPSEEK_TOKEN` / `GRAVITY_QWEN_TOKEN` in the bridge process environment. ChatGPT/Z.ai submit through dedicated browser profiles and capture network SSE. The service never reads your normal browser profile.

**Status.cmd** and **Models.cmd** perform readiness/model discovery without inference. Account verification consumes website quota and is a separate command in a terminal opened in this folder:

```powershell
.\runtime\node.exe .\bridge\cli.mjs probe chatgpt-web --data-dir .\.data
```

Use an alias returned by Models.cmd, such as `deepseek-web`, `qwen-web`, `chatgpt-web`, or `zai-web`. Websites control login requirements, available models, quotas, and guest access. No live-account inference was verified during implementation. Tool calls are prompt-emulated and validated; this service never executes commands or changes files on behalf of a model.

Private configuration/browser profiles stay in `.data/`. Keep that folder private and preserve it when upgrading; the packaged release contains no website sessions or API tokens. Moving the companion folder requires updating the saved Managed profile paths. The detailed source/API documentation is in `bridge/README.md`, and upstream notices are in `bridge/THIRD_PARTY.md` and `runtime/LICENSE`.

If Google shows **“This browser or app may not be secure”**, close the old setup browser and terminal and use the updated 1.7.0 login flow. All four websites use normal Chrome/Edge without automation/debugging flags for human sign-in. Google still controls account acceptance; complete its checks yourself or use another sign-in option offered by the website. Signing in in your usual browser does not prepare the separate bridge profile.

Browser Connector, standalone Web2API, and normal model APIs are separate connection options in Gravity. Normal OpenAI-compatible APIs accept arbitrary model IDs; each website requires its own adapter and actual account access.
