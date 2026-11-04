---
title: "T3 Code open source"
description: "Explore T3 Code's MIT license, architecture, source builds, contribution rules, provider integrations, and third-party notices."
updated: 2026-11-04
sources:
  - label: "Project overview and setup"
    url: "https://github.com/pingdotgg/t3code/blob/main/README.md"
  - label: "MIT license"
    url: "https://github.com/pingdotgg/t3code/blob/main/LICENSE"
  - label: "Architecture overview"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md"
  - label: "Contribution policy"
    url: "https://github.com/pingdotgg/t3code/blob/main/CONTRIBUTING.md"
  - label: "GitHub repository statistics, checked November 4, 2026"
    url: "https://github.com/pingdotgg/t3code"
faq:
  - question: "Is T3 Code open source?"
    answer: "T3 Code is open source under the MIT license. Its code is available in the pingdotgg/t3code GitHub repository."
  - question: "Can I build my own T3 Code?"
    answer: "T3 Code documents source setup with Vite+, using vp i and vp run dev. The repository also documents desktop packaging commands."
  - question: "Is T3 Code accepting contributions?"
    answer: "T3 Code's maintainers are not actively seeking outside contributions. Read CONTRIBUTING.md for approval requirements, focused exceptions, and verification evidence before starting a PR."
---

T3 Code is free, open source software under the MIT license, with source code published at `pingdotgg/t3code` on GitHub. You can inspect its implementation, build a local copy, or maintain a fork under that license.

## Find the source and license

Start with the [official repository](https://github.com/pingdotgg/t3code) when you want code, issues, or development documentation. It has more than 45,000 GitHub stars as of November 4, 2026. That dated count describes repository interest, rather than the number of people using the app.

The [MIT license guide](/learn/open-source/mit-license) explains what you can do with T3 Code's own code. It also separates the free application from the coding agents you connect. The repository identifies T3 Tools Inc. as the copyright holder.

For a ready-made app, use the [official download page](/download). A source build is useful when you want to change the application or investigate its behavior. You do not need to compile T3 Code to try it.

## Understand what runs on each machine

The [architecture guide](/learn/open-source/architecture) follows a request from the client through the server and provider adapter. It explains why an environment owns its files and agent processes, even when you control it remotely.

If you want the product-level explanation first, read about the [control plane for coding agents](/learn/concepts/control-plane-for-coding-agents). Then use the architecture guide to locate the implementation behind that idea.

## Build or change T3 Code

The [source build guide](/learn/open-source/build-from-source) walks through Vite+ installation, dependencies, development commands, and desktop artifacts. It also covers the pairing URL and separate development data directories.

Read the [contribution guide](/learn/open-source/contributing) before preparing an upstream change. Maintainers have limited review capacity. A working patch still needs the required scope approval and evidence for its changed behavior.

If your goal is another agent integration, start with [how providers plug into T3 Code](/learn/open-source/adding-a-provider). ACP support and native adapters have different entry points. Both need accurate capabilities and permission behavior.

## Inspect software included with the app

The [third-party license guide](/learn/open-source/third-party-licenses) shows where to read dependency and asset notices inside T3 Code. Those notices cover more than the application's own MIT license, including optional device tools installed on demand.

## Next steps

- [Read the MIT license explanation](/learn/open-source/mit-license) to understand reuse and forks.
- [Build T3 Code from source](/learn/open-source/build-from-source) to investigate a local change.
- [Check contribution requirements](/learn/open-source/contributing) before proposing that change upstream.
