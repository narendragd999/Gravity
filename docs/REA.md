# REA research for the Antigravity desktop implementation

Reviewed on 2026-11-02. Source: <https://github.com/morluto/rea>. Shallow checkout: `references/rea`. Exact revision: `144843ccc26bd372d61b8c6a27b37a01a5b0fb61`. Package: `rea-agents` 6.8.0. License: MIT, Copyright (c) 2026 morluto; retain its copyright and license when redistributing its code. The new desktop application does not embed REA code.

## What REA actually does

REA is a local analysis toolkit exposed through both a CLI and MCP. It gives an agent evidence for reconstructing software behavior; it is not an IDE or an automatic complete-app cloning engine. Its application layer keeps observations, inferences, unavailable information, provenance, and source identity separate. CLI and MCP reuse those workflows.

For Electron software, the useful route is desktop inventory followed by static JavaScript application analysis. Inventory examines installation paths and bounded headers without running the target. JavaScript analysis accepts an extracted application directory or ASAR and recovers modules, dependencies, Electron boundaries, IPC, routes, and native addon relationships. A feature trace follows a seed such as a module, IPC channel, event, or endpoint through the recovered graph. Static reachability does not establish actual runtime execution. Source maps and passive runtime evidence can improve coverage when available.

Relevant implementation and documentation:

- `src/application/artifacts/DesktopApplicationService.ts`: desktop inventory workflow.
- `src/application/javascript/JavaScriptApplicationService.ts`: JavaScript application workflow and evidence.
- `src/composition/javascriptAnalysisWorkerProcess.ts`: analysis worker composition.
- `docs/desktop-applications.md`: candidate runtime detection and coverage limits.
- `docs/javascript-application-workflows.md`: retained graph views and feature/semantic traces.
- `docs/installation.md`: setup and provider requirements.
- `docs/cli.md`: command execution and evidence export.

## Setup and use

The inspected package supports Node `^22.23.4 || ^24.22.1 || >=26.12.1`; `.nvmrc` pins 24.22.1. npm is required. Native decompilation additionally needs a suitable Hopper, Ghidra, IDA, or Kuna installation. Static JavaScript analysis does not require one of those native engines.

After reviewing the package and with a supported runtime, the documented setup is `npx rea-agents setup`. That command presents MCP registration and workflow instruction changes for approval, backs up existing configuration, and requires restarting the agent to expose the newly registered tools. It is not necessary to register MCP just to use the CLI. A one-off static command is:

```powershell
npx -y rea-agents@6.8.0 analyze-javascript-application 'C:/path/to/app/resources/app' --json
```

The source checkout build path is `npm ci`, followed by `npm run build:cached`. Those dependency installation/build commands were not run during this research; the source checkout and inspection are complete. No target binary was executed, patched, injected into, or uploaded.

## Application to this project

Use the current public Antigravity product behavior as the feature specification: agent manager, project navigation, conversations, planning/build modes, editor, command output, and reviewable artifacts. Record confirmed features separately from unavailable proprietary behavior. Reimplement the visible interactions using original application code and a provider abstraction.

Keep four boundaries explicit: renderer, privileged desktop operations, model protocol adapters, and the exposed HTTP gateway. Route provider requests from the privileged backend so the renderer never needs API secrets. Preserve user-specified base URLs and custom model identifiers. Require explicit review for generated file writes and commands, and preserve previous file contents. Represent stream cancellation, upstream errors, and incomplete work as real states.

REA can support deeper future parity investigations of an authorized installation, but these notes do not claim complete reverse engineering of Google's service, extension host, browser agent, or private model infrastructure. Public UI reconstruction and API interoperability can be delivered independently of those unavailable components.
