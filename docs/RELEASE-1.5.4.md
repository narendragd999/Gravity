# Gravity 1.5.4

Website connections can now be prepared inside the desktop app with **Connect & start** under **Settings → Get started** or **Web2API Bridges**. Gravity handles private configuration, provider connection, model discovery, managed startup, and chat selection for Z.ai, ChatGPT, DeepSeek, and Qwen. Users no longer need to run Setup/Info/Start launchers or paste the generated local key.

The portable executable includes the website bridge and Node runtime. Existing sidecar sign-ins are preferred when their Gravity-Web2API folder is beside the executable. Fresh bundled installations save configuration and browser profiles in the permanent Gravity user-data folder. Managed paths are refreshed when the portable executable unpacks into a different folder on a later launch.

ChatGPT/Z.ai sign-in opens normal Chrome/Edge in a separate profile. The user completes website checks, opens a new empty chat, and closes that browser; setup then continues automatically without terminal input. DeepSeek/Qwen use an in-app sign-in completion button. **Sign in again** provides recovery for expired sessions. Setup and model discovery do not submit inference prompts.

Existing external services are checked and reused without taking ownership of their processes. Cancellation stops only helpers and services created by that setup operation. Saved model-provider credentials remain encrypted, and helper output containing account information is not sent to the renderer.

Website accounts and security checks remain under the website's control. Website model aliases refer to the account's selected model. Local fixture checks verify setup and integration; they do not prove live account compatibility for every website.
