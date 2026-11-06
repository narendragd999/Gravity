# Release signing and controlled updates

The current development build is unsigned. The owner has no signing certificate or Trusted Signing account and requested that signing setup be prepared. The update service and release gates are implemented; no certificate was purchased, no private key was created, and no signed release was published.

## What the desktop does

**Check for updates** reads the latest published stable release from the official `narendragd999/Gravity` repository. It accepts an exact versioned Windows x64 portable executable and `SHA256SUMS-VERSION.txt`. It does not read account credentials, include project/chat data in the request, or accept another repository's download link.

**Download verified update** is available only in a build with an approved signing certificate. Downloads stay on approved GitHub HTTPS hosts, have size/deadline/cancellation limits, and must match both the release checksum and GitHub's digest when present. Windows must report a **Valid** Authenticode signature, the signer certificate must match a bundled SHA-256 certificate fingerprint, and the signed product-version resource must match the selected release. Renaming an older signed executable cannot promote it as a newer update. Existing files are never overwritten. The desktop reveals the resulting file; the user closes Gravity and launches the portable executable when ready. It never runs a downloaded update automatically.

The public trust configuration is `electron/release-policy.json`. The development policy contains an empty `trustedSignerSha256` list, so checks work but verified executable downloads are disabled. Trust cannot be expanded through imported backups, provider settings or renderer arguments. A SHA-256 checksum alone does not establish publisher identity.

## Prepare a signing identity

1. Obtain a Windows code-signing identity from an appropriate certificate authority or supported cloud signing provider. This requires the owner's account, identity verification and any payment. An existing authorized exportable `.pfx`/`.p12` code-signing certificate works with the prepared workflow. Modern hardware-backed or cloud signing services may require their provider's signing hook instead; do not export a hardware key or replace it with a self-signed certificate.
2. Keep the private key and password outside the repository, source ZIP and chat. Give the signing account only the repository/release access needed for this project.
3. Obtain the SHA-256 fingerprint of the signer's **public DER certificate**. It is the SHA-256 of `SignerCertificate.RawData`, not the SHA-1 thumbprint shown by many Windows dialogs. The public fingerprint may be committed; the private key may not.
4. If using Microsoft Trusted Signing or another service with rotating short-lived certificates, configure a reviewed signing/rotation policy before adopting it. The prepared workflow uses a pinned classic certificate; it does not claim that rotating cloud leaf certificates will continue matching the same pin. See [electron-builder's Windows signing documentation](https://www.electron.build/docs/features/code-signing/code-signing-win/) for provider hooks and cloud options.

## Configure the prepared GitHub workflow

1. In this repository, create a GitHub environment named **signed-release**. Require a reviewer and restrict it to the protected release branch/tags. Do this before adding signing credentials; naming an environment in YAML does not itself configure approval rules.
2. Add environment secrets **WIN_CSC_LINK** and **WIN_CSC_KEY_PASSWORD**. `WIN_CSC_LINK` is the authorized PFX file/base64 value supported by electron-builder; the password belongs in the separate secret. Do not paste either value into workflow YAML or a release note.
3. Add environment variable **GRAVITY_SIGNER_CERT_SHA256** with the 64-character public certificate fingerprint. `scripts/release-build.mjs` writes this public pin into the app before building and passes private signing variables only to the signing process.
4. Set the stable version in `package.json`, update the lockfile and write `docs/RELEASE-VERSION.md`. Commit the reviewed source and create/push its exact `vVERSION` tag. The signing script requires a clean source checkout and refuses a tag that differs from the package version or checked-out commit.
5. Run **Prepare signed Windows release** from Actions using that tag. Leave **create_draft** off for the first candidate. The workflow fails immediately if signing is not configured; it never promotes an unsigned result as signed.
6. Inspect the candidate and confirm its publisher in Windows file properties. Both the portable wrapper and unpacked Gravity executable must pass Valid Authenticode plus the configured certificate pin, followed by all release checks.
7. Run with **create_draft** enabled when a reviewable GitHub draft is wanted. Inspect its executable, source ZIP, checksums and versioned release notes, then publish the draft yourself. Update checks ignore drafts and prereleases.

The first certificate-pinned release must be installed deliberately. An older development build with an empty trust policy cannot bootstrap a new signer by trusting a mutable online checksum. Certificate renewal/rotation should be shipped in an already trusted release before the old identity is retired.

## Clean Windows acceptance

The **Windows release acceptance** workflow runs on a fresh `windows-latest` hosted runner for pushes, pull requests and manual runs, with read-only repository permission and no signing secrets. Actions are pinned to inspected commit IDs. It installs Node 22.22.2, Go 1.26.5 and the npm lockfile, runs the included Gemini bridge's Go tests with its locked dependencies and automatic toolchain switching disabled, then runs source regressions, compiles/packages the app, runs the native desktop and isolated website DOM fixtures sequentially, checks a relocated portable executable with developer runtimes removed from PATH, and verifies the curated source/archive/resource inventory and SHA-256 checksums. The signed-candidate workflow uses the same pinned toolchains and acceptance gate.

Run the same gate locally with `node scripts/release-check.mjs`; `--built` retains a candidate that has already been built/signed. Install Windows x64 Go 1.26.5 first, or set `GRAVITY_GO_EXECUTABLE` to the absolute path of that toolchain's `go.exe`. The gate rejects a different Go version and does not edit `go.mod`/`go.sum` to make tests pass. Application fixtures use disposable data and authored files; they do not establish live website/account/CAPTCHA compatibility. The hosted workflow must actually pass after push before describing a release as clean-runner validated. A physical Windows machine/virtual-machine test remains useful for browser installation, SmartScreen and device-specific behavior.

References: [GitHub release API](https://docs.github.com/en/rest/releases/releases), [release asset digests](https://docs.github.com/en/rest/releases/assets), [Windows signature verification](https://learn.microsoft.com/powershell/module/microsoft.powershell.security/get-authenticodesignature), and [electron-builder signing configuration](https://www.electron.build/docs/features/code-signing/code-signing-win/).
