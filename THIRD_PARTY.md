# Third-party components and references

This independently implemented desktop application uses Electron (MIT; Chromium and other bundled components have their own notices), React/React DOM (MIT), Monaco Editor (MIT), @monaco-editor/react (MIT), Lucide (ISC), react-markdown (MIT), and remark-gfm (MIT). Build tools include Vite, TypeScript, and electron-builder. The dependency versions are pinned in pnpm-lock.yaml. Electron's LICENSE and LICENSES.chromium.html accompany packaged runtime files; collected dependency notices are included in THIRD_PARTY_LICENSES.txt.

Research references, not embedded Google source:

- https://github.com/morluto/rea — MIT, copyright 2026 morluto; inspected at 144843ccc26bd372d61b8c6a27b37a01a5b0fb61.
- https://github.com/ikhsan3adi/gemini-web2api — MIT, copyright 2026 Ikhsan Satriadi; inspected at 4b9ce2674313dac8940f9277bd89a6c550dc1b0e. Runs separately when configured by the user; no bridge binary, session cookies, or credentials are included in this distribution.
- https://antigravity.google/docs/overview — public interaction/design reference. Google Antigravity and Google are their respective owners' trademarks. This application is independent and is not an official Google product. It does not embed Google's proprietary agent service, binaries, or account system.
