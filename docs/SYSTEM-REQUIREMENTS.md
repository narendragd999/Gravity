# System requirements and portability

The current distribution is a Windows x64 portable executable with Electron and its Node runtime included. The target is Windows 10/11 x64. It is not a universal binary: macOS, Linux, Windows ARM, and other operating-system versions have not been built or validated. A clean-machine installation test has not been performed.

## What is included

The desktop interface, local API gateway, browser connector server, and companion-extension files are bundled. Starting the desktop and using website chat does not require separately installing Node.js, Python, or Git.

## What the machine still needs

- Google Chrome 120 or later, installed in a standard Windows location, with permission to load the companion extension. Organization-managed Chrome may prohibit unpacked extensions.
- Internet access and a working signed-in account for each website used. Website limits, challenges, model availability, and layout changes still apply.
- Local port 4319 available for the browser connector. The API starts on port 4318 by default; its port and startup preference can be changed separately.
- Windows PowerShell for application command tools. Any Python interpreter, PDF library, compiler, package manager, or other command requested by a task must also be available on the machine. Those tools are not bundled. The Changes panel requires Git.
- Separately installed/configured services for external bridges, Ollama, or other local model providers. Remote APIs require their own provider configuration and credentials.

Website model aliases choose a website. They do not supply a local model, an offline service, or native provider tool support. Browser application tools use a structured text protocol and remain subject to the desktop's permissions.

## Moving to another computer

The executable can be copied, but new app profiles are stored separately in `%APPDATA%\Gravity`. Existing Antigravity Studio profiles continue using `%APPDATA%\Antigravity Studio` to retain saved data and the installed extension path. Project and external-tool paths are machine-specific. Saved credentials are protected using the Windows user's encryption context and should be re-entered on another machine rather than assumed portable. Install/pair the extension and sign in to websites on the destination computer.

## Checking a website

`Tab detected` means a supported chat input was found. It does not prove that a completed response can be produced. Use **Settings → Browser Connector → Test response** for the website. A passed test verifies that single text reply, not future availability or successful application tool calls.
