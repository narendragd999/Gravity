# Product direction and naming

Prepared on 6 November 2026 for the Gravity desktop workspace. The current executable, saved data and repository retain the Gravity name. The five priorities below are implemented in the 1.9.0 source. Actual publisher signing still needs the owner's certificate setup.

## Recommended name: OrbitDesk

**OrbitDesk** is the preferred naming proposal: a desktop where model connections, documents and project work come together. It distinguishes the app from similarly named Antigravity products and gives its local model-routing role a simple visual theme. The proposed wordmark uses **“Your AI workspace, connected.”**

**RelayDesk** emphasizes the local API and connection-routing function. **AgentDock** emphasizes the project workspace. OrbitDesk best covers the whole desktop rather than one subsystem. Name/domain/package availability has not been verified, and the proposed branding does not rename this release or move saved data.

The orbit-style logo concept uses a compact central shape and surrounding route. Its application icon must remain readable at 16/32 pixels, in monochrome, and in light/dark themes. A future rename should update visible labels, the executable and documentation together while preserving the stable app/data identity and migration path. Logo artwork is kept under `docs/branding/` for review.

## Implemented 1.9.0 improvements

| Priority | Improvement | Concrete completion standard |
| --- | --- | --- |
| 1 | Preserve drafts per chat | Switching chats or restarting the app restores unsent text. File references restore only with safe revalidation/reselection; expired IDs do not silently grant new file access |
| 2 | Simplify connection choices | One beginner page explains “get a model response” and “use models in another app,” distinguishes normal Chrome from a dedicated profile, and directs failed checks to the relevant recovery action |
| 3 | Keep verified response history per route | Each website/model retains its last successful/failed explicit response check and timestamp after restarting, without implying that service health alone proves generation |
| 4 | Preview extracted documents and add bounded OCR | Users can inspect the exact text that will be sent, including page/sheet/slide labels; scanned PDFs can use cancellable local OCR with page/byte/output limits and clear errors |
| 5 | Strengthen release acceptance | A clean Windows release run covers native cancellation, all four packaged document formats, relocation without developer runtimes, website service startup and backup recovery; verified manual update checks/downloads and signing workflows are implemented; a certificate remains required for signing |

The current source already provides Chat/Plan/Build modes, project scopes, edit review/Undo, bounded document extraction, progress/cancellation, safe error messages, saved website sessions and local API routing. The implemented priorities extend those workflows. Adding tools or automatic failover should preserve prompt ownership and require a deliberate new request whenever the previous website submission may already have occurred.

See [connections explained](CONNECTIONS-EXPLAINED.md), [OpenCode comparison](OPENCODE-STANDARDIZATION.md), and [release notes](RELEASE-1.9.0.md) for the current behavior and its acceptance limits.
