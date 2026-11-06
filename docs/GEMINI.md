# Gemini setup in Gravity 1.9.0

Choose the connection that matches what you already have:

| Connection | What you need | Where to set it up |
| --- | --- | --- |
| Gemini in normal Chrome | A signed-in Gemini tab and Gravity's Chrome extension | **Settings → Browser Connector** |
| Included Gemini Web2API bridge | The separate rebuilt executable and your private Gemini configuration | **Settings → Web2API Bridges → Gemini adapter** |
| Google Gemini API | A Google API key and a model available through that API | **Settings → Models & providers** |

For an existing signed-in Chrome session, follow the [Browser Connector guide](BROWSER-CONNECTOR.md#one-time-chrome-setup), connect the Gemini tab, then select `gemini-web` in Gravity. The standalone bridge has its own configuration and session credentials.

## Get the optional bridge executable

**`Gravity-Gemini-Web2API-1.9.0-x64.exe`** is an **unsigned development build** of the included Go source. It is available through either of these paths:

- **Local Windows build:** run `node scripts/package-gemini.mjs` from the Gravity checkout with Windows x64 Go 1.26.5 installed. The script builds the executable in [`release/`](../release/) and checks that `--version` reports `gemini-web2api gravity-1.9.0`. The full development release check also builds it.
- **Reviewed workflow artifact:** open the [Windows release acceptance workflow](https://github.com/narendragd999/Gravity/actions/workflows/windows-acceptance.yml), select a successful run for the commit you intend to use, and download its **Gravity-Windows-development-…** artifact. Extract the ZIP and locate the versioned Gemini executable and `SHA256SUMS-1.9.0.txt`. Compare the executable's SHA-256 with its entry in that checksum file before selecting it in Gravity.

The signed release workflow publishes the signed desktop executable and source archive; it does **not** include this optional bridge by default. The development bridge is a separate user-selected program and is not supplied through Gravity's verified desktop update download. Go and Python are not needed to run a prebuilt bridge executable.

If you are building locally with a task-specific Go installation, set `GRAVITY_GO_EXECUTABLE` to its `go.exe` before running the packaging script. See [Build and integration reference](#build-and-integration-reference) for the direct Go command.

## Upgrade an already working Gemini bridge

Obtain the [optional development bridge](#get-the-optional-bridge-executable) and keep `Gravity-Gemini-Web2API-1.9.0-x64.exe` in a permanent folder, for example `Documents\Gravity-Gemini`.

1. Open Gravity and select **Settings → Web2API Bridges**.
2. Find **Gemini adapter** below the separate website-profile and bridge sections.
3. Click **Stop bridge** if it is running. If you started your old bridge in a separate terminal, stop that instance with **Ctrl+C** in its terminal first.
4. Beside **Executable**, click **Browse** and select `Gravity-Gemini-Web2API-1.9.0-x64.exe`.
5. Leave **Configuration file** pointing at your existing private Gemini JSON configuration. It must refer to your own working cookie file.
6. Click **Save & start bridge**. Wait for **Gemini bridge is running**. Startup can take up to 90 seconds while the upstream service initializes.
7. Open **Settings → Models & providers** and select **Gemini Web2API**.
8. Click **Discover models**. The returned model IDs are saved automatically. A model appearing here is a bridge registry entry; test it to check whether your account can actually generate an answer.
9. In **Default model**, choose an exact ID from that list. Click **Save provider**, then **Test model**.
10. After the response test succeeds, click **Save & use in chat**. Start a new chat and send `Reply with only OK.` before returning to a Build task.

Installing a newer Gravity desktop does not replace a previously selected external bridge executable. Step 4 explicitly selects the rebuilt bridge. Keep your existing private configuration and cookies; no new cookie export is needed while that session still works.

## First-time setup for the included bridge

Once configured, **Start this adapter when Gravity opens** starts your selected executable with the app. Go and Python are not needed to run its prebuilt Windows executable.

### 1. Create a private setup folder

1. Open File Explorer with **Win+E**.
2. Open **Documents**, create a folder named **Gravity-Gemini**, and copy the [optional development bridge executable](#get-the-optional-bridge-executable) into it.
3. Keep the private `cookie.txt` and `config.json` files below in this folder. These files contain your Google session; keep them out of Git, shared backups, screenshots, and chat messages.

### 2. Prepare your own Gemini session

1. Open [Gemini](https://gemini.google.com/app) in Chrome and sign in to the account you want to use. Complete any website security check yourself.
2. Press **F12** to open Chrome Developer Tools.
3. Select **Application**. Expand **Cookies** on the left, then select `https://gemini.google.com`.
4. Find `SID`, `HSID`, `SSID`, `APISID`, `SAPISID`, and `__Secure-1PSID`. Copy each cookie's **Value** into a private Notepad document using this one-line format:

   ```text
   SID=YOUR_SID; HSID=YOUR_HSID; SSID=YOUR_SSID; APISID=YOUR_APISID; SAPISID=YOUR_SAPISID; __Secure-1PSID=YOUR_1PSID
   ```

5. Replace each `YOUR_...` placeholder with that cookie's value. Keep the cookie names, equals signs, and `; ` separators.
6. In Notepad, select **File → Save as**. Choose the **Gravity-Gemini** folder, set **Save as type** to **All files**, name it `cookie.txt`, and use **UTF-8** encoding.

This format follows the included [authentication reference](../bridges/gemini-web2api/README.md#how-to-get-cookies). Cookie availability and model access depend on your Google account. A listed Pro model does not establish account access or prove which upstream model Google actually used.

### 3. Create the configuration

1. Open a new Notepad document and paste:

   ```json
   {
     "host": "127.0.0.1",
     "port": 8081,
     "default_model": "gemini-3.6-flash",
     "cookie_file": "cookie.txt",
     "auth_user": "",
     "xsrf_token": "",
     "api_keys": [],
     "retry_attempts": 1,
     "retry_delay_sec": 2,
     "request_timeout_sec": 180,
     "log_requests": false,
     "temporary_chats": true
   }
   ```

2. Select **File → Save as**, choose the same folder, set **Save as type** to **All files**, and save as `config.json` using **UTF-8** encoding. Check that it is not named `config.json.txt`.
3. If your signed-in Gemini URL contains `/u/1/`, change the empty `auth_user` value to `"1"`; use the actual account index from your URL. For an `xsrf` error, refresh Gemini and follow the included [account and XSRF instructions](../bridges/gemini-web2api/README.md#authenticated-account-path-and-xsrf-token) to fill in the current private `xsrf_token`.

`gemini-3.6-flash` is an included bridge alias. Refresh the bridge list and test a returned alias after startup. Native Google API IDs come from Google's separate model list.

### 4. Link the files in Gravity

1. Open **Settings → Web2API Bridges** and find **Gemini adapter**.
2. Click **Browse** beside **Executable** and select the rebuilt executable from your setup folder.
3. Click **Browse** beside **Configuration file** and select your private `config.json`.
4. Keep **Bridge port** at `8081`, unless another service already uses it. The port field is inside **Advanced settings & process output**.
5. Click **Save & start bridge** and wait for **Gemini bridge is running**.
6. Follow steps 7–10 in [Upgrade an already working Gemini bridge](#upgrade-an-already-working-gemini-bridge) to discover, save, test, and use the connection.

Gravity resolves `cookie.txt` beside the configuration. Its private launch copy binds to `127.0.0.1`, generates an API token, and disables request logging. When the health endpoint responds, Gravity saves the **Gemini Web2API** provider and matching token automatically. At the default port, this provider uses **OpenAI compatible** protocol and `http://127.0.0.1:8081/v1`.

## Set up the native Google Gemini API

This connection sends API requests directly to Google and uses a Google API key. A Gemini website login and bridge cookie file do not supply that key.

1. Get an API key for your own Google project from [Google AI Studio](https://aistudio.google.com/apikey).
2. Open **Settings → Models & providers**.
3. Select **Google Gemini**, or add a provider and choose the **Google Gemini** preset.
4. Enter your **API key** and leave **Default model** blank while discovering. Expand **Connection details & additional models** and check **API protocol: Google Gemini** and **Base URL: `https://generativelanguage.googleapis.com/v1beta`**.
5. For an old connection, remove guessed or unavailable IDs such as `gemini-1.5-flash` and `gemini-1.5-pro` from **Default model** and **Additional model IDs** in that expanded section.
6. Click **Save & discover models**. This saves the connection, requests Google's current model list, and saves returned IDs advertising text generation. New Google Gemini presets contain no guessed model IDs.
7. In **Default model**, select a returned ID with its exact spelling. Gravity removes Google's `models/` prefix for the picker.
8. Click **Save provider**, then **Test model**. After it succeeds, click **Save & use in chat** to apply that exact saved model to the current chat.

**Test model** sends a separate short `Reply with only OK.` request and records the result for that model. It does not send your draft or replay a failed chat request. Discovery and process health are separate from successful generation. Model availability, quotas, billing, and supported API versions are controlled by Google.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| Nothing is accepting connections at `127.0.0.1:8081` | Open **Web2API Bridges → Gemini adapter**, click **Save & start bridge**, and check that the provider uses the same port. |
| Port already in use | Stop your old bridge in its own terminal, or choose an unused bridge port. Gravity leaves unrelated processes running. |
| `gemini-1.5-flash` / `gemini-1.5-pro` is not found or does not support generation | Check the native Google Base URL, use **Save & discover models**, choose a returned ID, then **Save provider → Test model → Save & use in chat**. |
| The chat model differs from the model you just tested | Use **Save & use in chat**, then check the composer's selector. Saving a provider alone does not change an existing chat's selection. |
| Gemini Web2API returned no answer | Explicitly select the rebuilt executable, check the Google session and bridge model, then test again. The normal Chrome Browser Connector is another option. |
| The bridge substituted a different model | Refresh the bridge list and choose a recognized ID. Gravity rejects an explicit `X-Model-Fallback: true` result. |
| CAPTCHA or browser verification | Complete the check yourself in Chrome. For Browser Connector, reconnect the verified Gemini tab in the extension. Website checks can recur. |
| Cookie / `xsrf` / account error | Refresh Gemini and update the private cookie or XSRF token. Match `auth_user` to the account URL, then stop and restart the bridge. |
| A model is listed but its test fails | Choose an available model and use the failure details to check account access or connection settings. A registry entry alone does not establish generation. |

## Included 1.9.0 response fixes

- JSON generation with no recognized, nonblank answer returns `empty_response`.
- Streams containing only metadata or whitespace emit an SSE error event, without a successful finish marker or `[DONE]`.
- An empty response is not automatically replayed. Other transport/upstream retries follow the configured attempt count. Zero or negative `retry_attempts` still makes one request.
- Valid final JSON without a trailing newline is read correctly.
- Tool-only replies remain valid when every call has a name and valid object arguments. Malformed or incomplete tool fences fail the whole batch; valid calls from that failed batch are not returned for execution.
- Gravity checks the final answer/action batch for JSON and streaming callers. Empty, reasoning-only, blocked, malformed-tool, and explicitly substituted-model results show **Needs attention**. Failure text stays out of later assistant history.

Tool calls are generated through prompted fenced JSON. Each bridge request creates an independent upstream conversation and includes earlier chat messages in its prompt. Website changes, account access, and session expiry can still affect results. Local fixtures verify protocol/error handling; no live Gemini account was used to establish compatibility for these fixes.

## Build and integration reference

The source is based on [ikhsan3adi/gemini-web2api](https://github.com/ikhsan3adi/gemini-web2api), inspected at commit `4b9ce2674313dac8940f9277bd89a6c550dc1b0e`, with the local response, retry, tool-parser, and SSE fixes above. MIT license, copyright 2026 Ikhsan Satriadi.

The actual `go.mod` requires **Go 1.26.5**, despite the preserved README's older Go 1.22+ statement. From a checkout, an advanced user with Go 1.26.5 for Windows x64 can build in PowerShell:

```powershell
Set-Location 'E:\application\Antigravity\Gravity\bridges\gemini-web2api'
$env:GOTOOLCHAIN = 'local'
go build -mod=readonly -trimpath -ldflags '-X main.Version=gravity-1.9.0' -o '..\..\release\Gravity-Gemini-Web2API-1.9.0-x64.exe' .
```

Use your own checkout location and create its `release` folder first if needed. Inspect the built version without starting a server:

```powershell
& '..\..\release\Gravity-Gemini-Web2API-1.9.0-x64.exe' --version
```

There is no `--host` CLI flag; JSON controls the listening host. Flags include `--port`, `--config`, `--cookie-file`, `--proxy`, `--impersonate`, and `--version`. Config discovery uses the explicit flag, `GEMINI_WEB2API_CONFIG`, working-directory `config.json`, then the user configuration directory.

| Method | Standalone bridge route | Purpose |
| --- | --- | --- |
| GET | `/` | Process health/version |
| GET | `/v1/models` | OpenAI-shaped bridge registry |
| POST | `/v1/chat/completions` | Chat JSON or SSE |
| POST | `/v1/responses` | Responses adapter |
| GET | `/v1beta/models` | Google-shaped bridge registry |
| POST | `/v1beta/models/{model}:generateContent` | Google-shaped JSON generation |
| POST | `/v1beta/models/{model}:streamGenerateContent` | Google-shaped SSE generation |

Gravity's **Share models** local API has its own [route set and key](CONNECTIONS-EXPLAINED.md); it is a separate service.
