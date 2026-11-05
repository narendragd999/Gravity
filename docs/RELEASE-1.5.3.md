# Gravity 1.5.3 — standalone website bridges

Adds the standalone DeepSeek, Qwen, ChatGPT, and Z.ai service, independent of Gravity's Browser Connector extension. DeepSeek/Qwen use authenticated HTTPS; ChatGPT/Z.ai use dedicated persistent Chrome/Edge profiles and network SSE capture. Existing Gemini/Claude adapters remain available separately.

The Windows release includes `Gravity-1.5.3-x64.exe` and its `Gravity-Web2API` companion folder with Node, playwright-core, and setup/login/start/info launchers. Keep both in a permanent writable location. Follow the [Windows setup instructions](../bridges/multi-web2api/WINDOWS.md). Website sessions are prepared manually and reused. No API tokens or browser sessions ship with the release.

Get started now separates Browser Connector, normal APIs, and standalone Web2API. Models & providers includes a Gravity Web2API draft preset at port 4320; selecting it does not save settings or invent model access. Existing Managed profiles provide automatic startup.

The local service authenticates with a generated token separate from website credentials, limits requests, cancels downstream work, serializes each provider, and validates completed text/tool responses before returning buffered OpenAI SSE. Tool names/arguments are validated, and the bridge never executes tools.

Automated fixture tests cover all four adapters, configuration races, security, tool turns, and intercepted installed-browser traffic. Live inference requires the user's configured account and an explicit probe. This release does not claim universal access to every website/model. Gravity's existing normal API support accepts arbitrary OpenAI-compatible backend model IDs.
