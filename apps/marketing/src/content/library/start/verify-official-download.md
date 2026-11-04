---
title: "How to verify you have the official T3 Code"
description: "Verify an official T3 Code download through t3.codes, the release repository, mobile store listings, and documented signing and checksum checks."
updated: 2026-11-04
sources:
  - label: "Install T3 Code, npx option (docs/user/install.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Official download page"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/marketing/src/pages/download.astro"
  - label: "Release selection and official repository"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/marketing/src/lib/releases.ts"
  - label: "Official repository and mobile store links"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/marketing/src/lib/site.ts"
  - label: "Release signing and archive checksums"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/operations/release.md"
  - label: "Shell archive verification"
    url: "https://github.com/pingdotgg/t3code/blob/main/scripts/install.sh"
  - label: "PowerShell archive verification"
    url: "https://github.com/pingdotgg/t3code/blob/main/scripts/install.ps1"
  - label: "Installer staging"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/marketing/scripts/stage-install-scripts.mjs"
  - label: "Security reporting and credential responsibilities"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/marketing/src/pages/security-policy.astro"
  - label: "Cost and licensing"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/faq.md"
  - label: "License"
    url: "https://github.com/pingdotgg/t3code/blob/main/LICENSE"
faq:
  - question: "What is the official T3 Code website?"
    answer: "The only official T3 Code website is t3.codes. Start at t3.codes/download for desktop downloads, installer commands, and official mobile store links."
  - question: "Where are official T3 Code releases hosted?"
    answer: "T3 Code publishes releases at github.com/pingdotgg/t3code/releases. Follow that repository directly or the links from t3.codes/download."
  - question: "Are all T3 Code builds signed and notarized?"
    answer: "The T3 Code release workflow makes signing optional, based on available platform secrets. Its documentation describes Apple signing and notarization and Azure Trusted Signing for Windows, but does not establish that every published artifact is signed."
  - question: "Does the T3 Code installer check a checksum?"
    answer: "The official T3 Code CLI installers download SHA256SUMS from the matching GitHub release and check the archive before extraction. A matching checksum supports integrity only when the checksum source is trusted."
  - question: "What if I downloaded T3 Code from another domain?"
    answer: "Do not run the file until you have checked its origin. Obtain T3 Code again through t3.codes/download, and revoke credentials that may have been exposed if you already ran an untrusted build."
---

T3 Code's only official website is `t3.codes`. Get desktop builds and installer commands from [Download T3 Code](/download), or use the official GitHub release repository and mobile store listings linked below. Check the source before running a download or entering provider credentials.

## Start from the official distribution links

Use these destinations to establish the source of your installation:

| What you need                            | Official destination                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Desktop downloads and installer commands | [T3 Code downloads](/download)                                                                    |
| Published release assets                 | [pingdotgg/t3code releases](https://github.com/pingdotgg/t3code/releases)                         |
| Run without installing                   | [`t3` on npm](https://www.npmjs.com/package/t3), as `npx t3@latest`                               |
| iPhone and iPad app                      | [T3 Code on the App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) |
| Android app                              | [T3 Code on Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code)        |

Read the address itself before downloading. A page title, search ranking, copied logo, or app name does not establish that a file came from the official project. If you arrive from any other domain, open `t3.codes` directly and follow its download links.

The release repository is `pingdotgg/t3code`. The mobile listing identifiers above come from the website's store-link configuration. Use those exact links rather than selecting an app by its display name alone.

## Check the release and installer you selected

1. Open [the download page](/download) directly.
2. Choose Stable or Nightly intentionally.
3. Select the installer for your operating system and processor.
4. Confirm that the desktop download is a release asset from `pingdotgg/t3code` on GitHub.
5. If you need a CLI, use the script URL shown on the official page.

The site's release loader selects Stable from GitHub's latest release and Nightly from a nightly-tagged release. It matches the chosen platform against the release assets. If a matching asset is unavailable, the link falls back to the releases page rather than manufacturing a download URL.

For installation details, use [macOS](/learn/start/install-macos), [Windows](/learn/start/install-windows), or [Linux](/learn/start/install-linux). A different filename or architecture is a reason to check the release selection before proceeding.

## Understand what signing and notarization establish

The release documentation describes Developer ID signing and notarization for macOS builds when the Apple credentials are present. It describes Azure Trusted Signing for the Windows installer and executables. Signing is optional and detected from available release secrets.

That means the documentation supports a signing process, not a claim that every file ever published is signed or notarized. The documented process does not specify a fixed certificate fingerprint or publisher string for you to compare. Check the selected artifact rather than assuming the same signature status across releases.

For a downloaded build, keep its origin and release identity as the first checks. If a platform reports an unexpected publisher or a verification failure, stop and recheck the official release. Do not bypass a warning because an unrelated page says the app is safe.

## Check CLI archives against the matching release

The release workflow attaches a `SHA256SUMS` file alongside self-contained CLI archives. The official shell and PowerShell installers download that file for the selected version. They compare the archive's SHA-256 digest before extracting it and fail on a mismatch.

The shell installer uses `sha256sum` or `shasum`. The PowerShell installer uses `Get-FileHash -Algorithm SHA256`. Both then check that the extracted executable runs before completing installation. The marketing build copies these scripts from the repository to the official `/install.sh` and `/install.ps1` paths.

If you compare a CLI archive manually, take its checksum from the same official release and match the exact archive filename. A checksum copied from the same untrusted download page cannot establish the project's identity. The documented checksum contract covers the CLI archives; it does not establish a checksum manifest for every desktop installer.

## What if you downloaded from any other domain?

If you have not run the file, leave it unopened and obtain a fresh copy through the official links. Do not enter credentials into that build while you investigate. T3 Code is free and [MIT licensed](/learn/open-source/mit-license); payment is not required to download or use the app.

If you already ran it, stop using the unverified build. Review which provider, repository, or environment credentials you supplied. Revoke any credentials you believe may be compromised, as the [security policy](/security-policy) directs. Installing the official app alone does not establish what an earlier untrusted program did.

For a suspected vulnerability affecting T3 Code, follow the security policy's private reporting process. Include the affected version, source URL, and sanitized evidence. Do not send passwords, API keys, access tokens, or private keys in the report.

## Next steps

- Install through [the official download page](/download) and follow [Get started](/learn/start).
- Read [security and privacy](/learn/safety/security-and-privacy) for the execution and data boundaries.
- Use [Update T3 Code](/learn/start/updating) to keep verified apps and connected servers current.
- Consult the [T3 Code FAQ](/learn/start/faq) for cost, provider, and mobile questions.
