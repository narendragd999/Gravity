# Included Claude Web2API: Windows setup guide

This guide uses the Claude Web2API Python bridge already included in this repository. The files are in `E:\application\Antigravity\Gravity\bridges\claude-web2api`. The Gravity executable alone does not include this optional Python bridge. Keep the source folder if you want to use it.

You need a Claude website account that you can sign into and use in your normal browser. Website account limits still apply. The steps below prepare the local connection; a successful response test establishes whether the bridge works with your current account.

## 1. Install Python once

1. Open [Python for Windows](https://www.python.org/downloads/windows/).
2. Install Python 3.10 or newer. Python 3.13 is the version used to inspect the included dependencies.
3. Enable the Python launcher (`py`) in the installer. If offered, select **Add Python to PATH**.
4. Finish installation.

## 2. Prepare the included bridge

1. Press **Windows + E** to open File Explorer.
2. Click the address bar, paste the following folder, and press **Enter**:

   ```text
   E:\application\Antigravity\Gravity\bridges\claude-web2api
   ```

3. Double-click **Setup.cmd**.
4. Wait while it creates a private `.venv` folder and installs the pinned Python packages. Internet access is needed.
5. When it says **Setup finished**, close the window.

Setup creates `config.json` only if it does not already exist. Your existing configuration is preserved. The example selects port **8082**, uses your normal direct internet connection, and disables request logging. Do not enter a proxy address unless you already use and understand that proxy.

## 3. Save your own signed-in Claude session

This optional bridge uses an exported website cookie file. That file grants access to your Claude session. Keep it private; do not upload it, paste it into chat, or commit it to Git. Gravity's source packaging and Git rules exclude it.

1. Open Firefox. Install it from [Mozilla](https://www.mozilla.org/firefox/new/) if needed.
2. Open [Claude](https://claude.ai/) and sign in yourself. Complete any website verification.
3. Check that you can open an empty Claude chat.
4. Install the [cookies.txt Firefox extension](https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/), as described by the included bridge's upstream documentation.
5. While on Claude, export cookies **for the current Claude site only** in **Netscape cookies.txt format**. Avoid exporting every browser site's cookies.
6. Save that export in the bridge folder from step 2 with the exact filename:

   ```text
   cookie_claude.txt
   ```

7. In File Explorer, enable **View → Show → File name extensions** and check the file is not named `cookie_claude.txt.txt`.

If you prefer to keep website sessions in Chrome without exporting cookies, use Gravity's [Browser Connector guide](BROWSER-CONNECTOR.md) instead. That is a separate Claude connection method.

## 4. Start the bridge

1. Double-click **Start.cmd** in the bridge folder.
2. Keep that window open. The local service uses:

   ```text
   http://127.0.0.1:8082
   ```

3. Open [the local health page](http://127.0.0.1:8082/health) in your browser. A JSON page means the service is listening. It does not prove that Claude can generate a response. Do not share the complete health output; it can include your organization identifier.

If the browser says the page cannot be reached, inspect the Start window for its error. Saving a provider in Gravity does not start this external server.

## 5. Add the provider in Gravity

1. Open **Gravity-1.8.0-x64.exe**.
2. Open **Settings → Models & providers**.
3. Click **Add provider**.
4. Enter these values:

   | Field | Value |
   |---|---|
   | Name | `Claude Web2API` |
   | Protocol | `OpenAI compatible` |
   | Base URL | `http://127.0.0.1:8082/v1` |
   | API key | Leave empty |

5. Save the provider, then click **Discover models**.
6. Choose a returned model label and save it as the default if needed.
7. Click **Test model**. This sends a short real message and uses your Claude website quota.
8. If the test succeeds, click **Use in this chat**.
9. Choose **Chat** mode for ordinary questions. Use Plan or Build for project work.

The included snapshot returns a fixed list of model labels. It does not forward the requested label as a verified model selection to Claude. A listed model is not proof that your account has access to that exact version. This bridge also does not validate a downstream local API key; keep it on loopback and do not expose port 8082 to other computers.

## 6. Let Gravity start it next time

After the first successful response test, you can replace manual Start.cmd launching with a managed profile:

1. In the Start window, press **Ctrl + C** to stop the manually launched server. Do not run two servers on port 8082.
2. In Gravity, open **Settings → Web2API Bridges**.
3. Expand **Advanced adapter profiles & configuration**.
4. Click **Add bridge** and set:

   | Field | Value |
   |---|---|
   | Name | `Claude local bridge` |
   | Model provider | Your saved `Claude Web2API` provider |
   | Launch mode | `Managed` |
   | Executable | `E:\application\Antigravity\Gravity\bridges\claude-web2api\.venv\Scripts\python.exe` |
   | Working directory | `E:\application\Antigravity\Gravity\bridges\claude-web2api` |
   | Health URL | `http://127.0.0.1:8082/health` |
   | Startup timeout | `60000` milliseconds |

5. Put this exact JSON array in **Arguments**:

   ```json
   ["E:\\application\\Antigravity\\Gravity\\bridges\\claude-web2api\\claude_web2api.py"]
   ```

6. Leave environment variables empty. Save the profile.
7. Click **Save & start bridge** and confirm that the profile becomes ready.
8. Enable **Start saved bridge profiles when Gravity opens**.

Next time, open Gravity. It starts the Python bridge while its files and saved cookie file remain in that folder. If you move the source folder, update the executable, argument, and working-directory paths.

## Problems and recovery

| What you see | What to do |
|---|---|
| Python launcher missing | Install Python with the launcher enabled, then rerun Setup.cmd. |
| Package installation fails | Check the internet connection and read the package error. Rerun Setup.cmd once corrected. |
| Missing config.json | Rerun Setup.cmd; it creates the file from the supplied example. |
| No cookies loaded / 401 | Sign into Claude again and replace your own site-only cookie export, then restart the bridge. |
| 403 or website verification | Open Claude in your normal browser and complete the website's checks. Live bridge compatibility is not guaranteed. |
| Port 8082 already in use | Stop the earlier Claude bridge or choose another port in config.json and update Gravity's URLs. |
| Models appear but the test fails | Model discovery is a local fixed list; check the actual response-test error and signed-in account. |
| 429 / quota limit | Wait for the website's indicated reset or use another prepared connection. |
| Service stopped after closing Start.cmd | Keep that window open, or configure the managed profile from step 6. |

The included Python source has been parsed and its setup paths inspected. These instructions do not claim a live Claude account response was verified during this release.
