---
title: "Open source licenses in T3 Code"
description: "Find T3 Code's third-party license notices on desktop, web, and mobile, search included software, and inspect attribution sources."
updated: 2026-11-04
sources:
  - label: "Open source license viewer instructions"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/open-source-licenses.md"
  - label: "Custom notices and attribution configuration"
    url: "https://github.com/pingdotgg/t3code/blob/main/third-party-licenses.config.json"
  - label: "MIT notice template"
    url: "https://github.com/pingdotgg/t3code/blob/main/third-party-licenses/spdx/v3.28.0/MIT.json"
  - label: "Apache notice template"
    url: "https://github.com/pingdotgg/t3code/blob/main/third-party-licenses/spdx/v3.28.0/Apache-2.0.json"
  - label: "T3 Code's own license"
    url: "https://github.com/pingdotgg/t3code/blob/main/LICENSE"
  - label: "License synchronization script command"
    url: "https://github.com/pingdotgg/t3code/blob/main/package.json"
faq:
  - question: "Where are T3 Code's open source licenses?"
    answer: "On T3 Code web and desktop, open Settings, About, then View licenses under Legal and Open source licenses. On mobile, open Settings, About T3 Code, then Open source licenses."
  - question: "Are all T3 Code dependencies MIT licensed?"
    answer: "T3 Code's own code is MIT licensed, while its third-party notices identify the licenses for individual included items. The configuration includes MIT, Apache-2.0, CC0-1.0, and combined-license entries."
  - question: "Can I search T3 Code's license notices?"
    answer: "T3 Code's license viewer searches by package, version, license, or app component. Select an item to read its full notice."
  - question: "Does T3 Code list optional device-tool licenses?"
    answer: "T3 Code's notices include optional device tools installed on demand. A listed item therefore does not necessarily mean that tool was bundled with the app."
---

T3 Code includes a searchable viewer for third-party software and asset license notices. Open it from Settings to see an item's license, version when available, applicable app components, and complete attribution text.

## Open licenses on desktop, web, or mobile

On web or desktop, follow these steps:

1. Open `Settings`.
2. Select `About`.
3. Find `Open source licenses` under `Legal`.
4. Select `View licenses`.

On mobile, use this path:

1. Open `Settings`.
2. Select `About T3 Code`.
3. Open `Open source licenses`.

The path differs because the clients have separate interfaces. The [architecture guide](/learn/open-source/architecture) explains how those clients fit around a server environment. The [license-viewer documentation](https://github.com/pingdotgg/t3code/blob/main/docs/user/open-source-licenses.md) is the source for these navigation steps.

## Find a package or read its complete notice

Use the search field to find a package, version, license identifier, or app component. Select a row to read the full notice text. The list shows the version when available and identifies which parts of T3 Code include or use the item.

For example, search by the package name when you know which dependency you are investigating. Search by a license identifier when you want to inspect entries carrying that identifier. Search by a component when you are looking at one part of the distribution.

Read the selected entry before drawing a conclusion from its name. The list also covers optional device tools that T3 Code installs on demand. Appearing in the viewer does not by itself establish that an optional tool is currently installed or bundled into your app.

| What you need to establish                 | What to inspect                         |
| ------------------------------------------ | --------------------------------------- |
| Which item is covered                      | Its name and version, when available.   |
| Which license applies                      | The license identifier and full notice. |
| Where T3 Code uses it                      | The app components listed for the item. |
| Whether an adapted asset needs attribution | Its specific notice and source entry.   |

## Separate the root license from included software

T3 Code's own source uses the [MIT license](/learn/open-source/mit-license). The third-party viewer answers a different question: which licenses and attributions accompany the software and assets the application includes or uses?

Do not treat the root MIT file as a replacement for every dependency notice. The repository's configuration includes distinct identifiers and combined-license entries. A distribution can include code, fonts, adapted viewers, sounds, and optional tools with their own notices.

If you are preparing a fork, inspect the notices for the components you distribute. Keep the root license and applicable third-party texts available for that review. The viewer provides a way to read them without searching through every source directory.

## Inspect the attribution configuration in the repository

The root `third-party-licenses.config.json` records custom notices and package metadata adjustments. Its entries show why a dependency list alone would miss parts of the application.

Examples from that configuration include:

- `opencode Office viewers`, an MIT-licensed web entry pointing to a notice file beside the adapted code.
- `Ionic keyboard assist`, an MIT entry associated with desktop and web bundles.
- Notification and SnapShot sound assets with CC0-1.0 notices identifying their original sources.
- `agent-device`, an MIT-licensed optional device-tool entry.
- `expo-device-hub`, a device-tool entry with an `MIT AND Apache-2.0 AND BSD-3-Clause` license expression.

These are examples from the checked configuration, rather than a complete inventory of a particular build. Use the app's viewer to examine the list presented by the app you are running.

## Where are the license texts and maintenance commands?

The repository keeps license text templates under `third-party-licenses/spdx/v3.28.0`. That directory includes MIT and Apache-2.0 texts alongside BSD, ISC, OFL, CC0, and Unlicense entries. Notice configuration can reference a separate notice file or provide generated-notice details such as copyright holders and a preamble.

The root `package.json` exposes `licenses:sync`, which invokes `scripts/sync-third-party-license-notices.ts`. Developers investigating a notice can start with that command's source and the configuration. A license text template's presence alone does not identify every package that uses it.

For local packaging, follow [the source build guide](/learn/open-source/build-from-source). For privacy questions, consult [security and privacy](/learn/safety/security-and-privacy); a license inventory addresses attribution rather than explaining data handling.

## Next steps

- Read [T3 Code's MIT license guide](/learn/open-source/mit-license) for the application's own reuse terms.
- Follow [source build instructions](/learn/open-source/build-from-source) when investigating a local distribution.
- Return to the [open source overview](/learn/open-source) for the other source guides.
