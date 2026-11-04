# Gravity 1.5.0

Antigravity Studio is now **Gravity**. The Windows portable build is **`Gravity-1.5.0-x64.exe`**. Double-click it from any folder; its desktop runtime, local API, Browser Connector, and extension files are included.

## What changed

- Browser Connector, Web2API Bridges, model providers, and the local API have separate settings pages with short explanations.
- A Get started page presents the browser and API-key connection methods. Advanced connection/process settings are tucked away until needed.
- The local API and Browser Connector start with the app by default. Configured Web2API services start independently, with visible status and errors. Existing explicit startup preferences are preserved.
- Approved browser pairing is saved with Windows encryption and reused on normal restarts. Revoking access still disconnects the extension.
- Text is larger by default. Appearance offers saved 100%, 110%, and 125% size choices.
- Startup uses saved bridge configuration instead of searching developer-specific folders or silently launching unconfigured Python scripts.

## Upgrade

1. Close the old desktop app and open `Gravity-1.5.0-x64.exe`.
2. Your existing conversations, provider settings, projects, and extension location remain available on the same Windows profile.
3. Open **Settings → Browser Connector → Open extension setup**. In Chrome's extensions page, click **Reload** on the existing connector. Recognized older install folders are updated in place. The renamed companion extension is **Gravity Browser Connector 1.0.3**.
4. Connect and approve once if this is your first pairing after upgrading. Later normal app launches reuse that approval.

If automatic startup was previously disabled, enable it on the appropriate settings page. Services display an error if a selected file is missing or their port is occupied. They do not terminate unrelated applications to reclaim a port.

## What still needs setup

Chrome requires a one-time unpacked-extension installation and explicit pairing approval. Sign in to each website yourself. Direct API providers need their keys; optional external Web2API programs still need their own runtimes and account configuration. Nothing in the portable executable includes working model credentials or offline models.

The distribution targets Windows 10/11 x64. Copying encrypted settings between computers does not transfer credentials. Website adapters remain subject to changing layouts, sign-in requirements, and account limits; fixture tests do not establish live account compatibility.
