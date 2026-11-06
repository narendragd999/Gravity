# Model connections, the local API, and Chrome

Gravity can request answers from several places, then offer the same connections to another app on your computer. These two directions have different settings and keys.

## A provider gets the model response

**Settings → Models & providers** describes where Gravity sends a request. The destination can be a hosted model API, a local model service such as Ollama, Gravity's website service, or Browser Connector.

For example, an OpenAI API provider uses that service's base URL and your OpenAI API key. A local Ollama provider points to its running local server. The bundled website setup fills its local connection settings automatically after you sign in. Saving a manually configured provider records the address; it does not start an external server.

## The local API lets another app use Gravity

**Settings → Share models** provides an OpenAI-compatible server on this computer, normally **`http://127.0.0.1:4318/v1`**. Other apps send their requests there, and Gravity routes each request to its selected provider/model.

```text
Other app → Gravity local API/gateway → configured provider → model answer
```

The key shown on the Share models page authenticates the other app to Gravity. It is a local access key and is separate from the upstream provider's key or website session. Copy the base URL, local key and an exact listed model ID from that page. Listed gateway IDs include the provider ID so routes remain distinct.

| Setting/address | What uses it |
| --- | --- |
| Model provider base URL and upstream API key | Gravity requests a model response |
| `http://127.0.0.1:4318/v1` and Gravity local key | Another app requests through Gravity |
| Bundled website bridge, normally `http://127.0.0.1:4320/v1` | Gravity's managed website provider; setup fills its private local key |
| Browser Connector transport, normally port `4319` | Gravity's Chrome extension communicates with the desktop; it is not an OpenAI client base URL |

If you only chat inside Gravity, choose a working model connection in the chat. The Share models page is useful when you want another app to use those models. A listening local API and a discovered model list still need a working upstream account/service to produce a reply; use **Test response/Test model** to check actual generation.

## Why website setup opens another Chrome window

**Connections → Separate saved website profile → Connect & start** uses a separate browser profile saved for the selected website account. It keeps that website session separate from your usual Chrome browsing profile and avoids reading or modifying the browser's other accounts, tabs, history and drafts.

Sign in once in that separate window, open a new empty chat, and close its windows when setup asks. Gravity checks the saved profile and reuses it later. If the reopened verification browser shows a security check, keep it open while completing the check yourself. The extra window is part of the dedicated profile method; it does not mean Gravity needs the sandbox disabled.

**Browser Connector** is the other method. Install and approve the extension in your usual signed-in Chrome profile. Gravity can then request through that profile without exporting website cookies or copying its saved credentials. Each request uses an owned task tab so an existing conversation or draft is not overwritten. A challenged task tab is shown for your attention; Gravity waits rather than solving its CAPTCHA.

| Choose this method | When it fits |
| --- | --- |
| Bundled website setup | You want app-managed startup and a separate saved website profile |
| Browser Connector | You want to use the account already signed into your normal Chrome profile, or the dedicated profile keeps receiving security checks |
| Hosted/local API provider | You have an API account or a running local model service |

These methods still depend on the website's account rules, available models and current interface. A website may ask for sign-in or security checks again. Browser Connector needs its one-time Chrome installation, pairing and updated extension code. See [the setup guide](SETUP.md) and [Browser Connector instructions](BROWSER-CONNECTOR.md).
