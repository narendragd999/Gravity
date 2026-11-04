# Gravity Browser Connector

Load this folder as an unpacked Chrome Manifest V3 extension. No build step or downloaded JavaScript is required. See `help.html` for setup and privacy details.

The connector pairs with the desktop app at `http://127.0.0.1:4319`; pairing requires explicit approval in that app. The popup checks the six allowlisted services and offers Open/sign-in controls. An app request creates a new task tab, submits text through that site's visible DOM, and returns only a newly rendered, verifiably completed assistant response. Website sign-in, challenges, and model selection remain manual. No cookies, session credentials, browser storage, or private web APIs are inspected.

Service adapters live in `core.mjs`; the isolated DOM runner is `dom.mjs`. `background.mjs` owns pairing, job dispatch, cancellation, and tab ownership. The popup never receives the pairing token. Successful task tabs close; failure tabs remain for troubleshooting. On worker restart, incomplete jobs are cancelled and reported instead of being silently resubmitted.

All six adapters are best-effort DOM integrations, not provider APIs. Selector/unit tests do not establish live compatibility with an account or a website version. The aliases identify websites, not guaranteed model versions. Function tools use a constrained JSON text format and still require the desktop app's authorization; there is no native website tool execution. Text-only requests are limited to 256 messages, 120,000 prompt characters, and 200,000 response characters. Website changes, account limits, or missing completion controls produce actionable errors.

Chrome host permissions are limited to the six exact HTTPS hosts and loopback port 4319. [Chrome's match-pattern documentation](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns) defines explicit port matching. The extension does not request cookies, webRequest, debugger, nativeMessaging, or all-sites access.
