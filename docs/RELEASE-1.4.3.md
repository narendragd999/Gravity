# Antigravity Studio 1.4.3

Windows x64 portable build, 3 November 2026. Companion extension 1.0.2, connector protocol 2.

## Why older errors kept appearing

Updating the desktop executable does not reload a Chrome extension. Earlier releases also prepared a different folder for each desktop version, so Chrome could keep loading 1.0.0 from an older folder. The old loading-timeout and tool-format wording is absent from the current extension.

The desktop now checks the extension protocol before pairing or sending any job, reports the detected version, and provides upgrade instructions for an outdated worker. An outdated client cannot receive a queued prompt. Version checks do not change permission settings or website sign-ins.

## Upgrade an existing installation

1. Stop running conversations, close the older desktop, and open `Antigravity-Studio-1.4.3-x64.exe`.
2. Go to **Settings → Web2API bridges → Browser connector** and click **Open extension setup**. It refreshes recognized version folders prepared by the app and copies files into `%APPDATA%\Antigravity Studio\browser-extension\current` for new installations.
3. In Chrome, open `chrome://extensions/`, enable **Developer mode**, and click **Reload** on **Antigravity Studio Browser Connector**. Confirm extension version **1.0.2**. If it still shows an older version because it was loaded from a different source folder, replace that installation using **Load unpacked** and the `current` folder shown by the desktop. Keep only one installation enabled.
4. Start the browser connector, click **Connect to app** in the extension, and approve it in the desktop if requested. Keep the website signed in in the same Chrome profile.
5. Run **Test response** for the desired website, then select its model alias in your chat and retry.

## Loading and tool handling

Readiness probes now use immediate injection instead of waiting for Chrome's document-idle state. Tab lookup and probe calls are bounded, cancellation does not wait for a stalled probe, and a slow site scan cannot block heartbeats indefinitely. The DOM runner checks the remaining time before editing or submitting a prompt. A request is injected at most once; failed attempts are not silently resubmitted.

Tools still require the entire assistant response to be one valid JSON envelope, with commentary in `content`. Embedded JSON examples are never executed. The stricter prompt from 1.4.2 remains. Actual website output can still violate that format; inspect the failed website reply if the error persists with extension 1.0.2.

Automated tests use disposable data and local website fixtures. Live website compatibility, sign-ins, and account-specific generation remain separate checks. See [validation](VALIDATION.md) and [system requirements](SYSTEM-REQUIREMENTS.md).
