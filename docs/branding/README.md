# Naming and logo proposal

Recommended name: **OrbitDesk**. It keeps Gravity's space theme while making the desktop workspace clearer. The orbit represents connected models; the central spark represents the agent. Teal and violet remain recognizable on the dark app icon.

Other options: **RelayDesk** emphasizes model/API connections; **AgentDock** emphasizes the project workspace. These are naming suggestions, not claims of trademark or domain availability.

The app remains named Gravity until a name is selected. This proposal does not migrate saved settings or rename the executable.

- `orbitdesk-icon.svg`: scalable app icon.
- `orbitdesk-logo.svg`: wordmark with tagline.
- `orbitdesk-icon.png` and `orbitdesk-logo.png`: rendered previews.

Use `node scripts/render-branding.mjs` to regenerate the previews from the SVG originals after `npm ci`. This source-only export uses the optional canvas dependency already present in the lockfile; include optional dependencies when installing. The PNGs have transparent rounded corners and fixed sizes of 512 × 512 and 900 × 250. No browser window or browser-security flags are needed.
