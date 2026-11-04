---
title: "Get started with T3 Code"
description: "Get started with T3 Code: choose an official installer, connect a coding agent, import projects, and keep your app and servers updated."
updated: 2026-11-04
sources:
  - label: "Install T3 Code"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Welcome wizard"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/welcome-wizard.md"
  - label: "Updating T3 Code"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/updating.md"
  - label: "Frequently asked questions"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/faq.md"
faq:
  - question: "Do I need a provider before installing T3 Code?"
    answer: "You can install and open T3 Code before configuring a provider. You need an installed, authenticated provider before starting a thread."
  - question: "Which T3 Code installer should I use?"
    answer: "Use the T3 Code desktop installer for your operating system, or the standalone CLI for a server. Intel Macs have a desktop app but no standalone t3 executable."
  - question: "Can I skip the T3 Code welcome wizard?"
    answer: "You can close T3 Code setup when no import is running. Connect computers and agents later in Settings, or open /welcome to return."
---

T3 Code runs coding agents on your computer and gives you desktop, web, and mobile ways to control them. Start by installing it on the machine that will run your agents, then connect an authenticated provider.

## Decide what to install

Read [What is T3 Code?](/learn/start/what-is-t3-code) if you want to understand the product before downloading it. T3 Code supplies the control surface; your selected provider supplies the agent runtime and account access.

Choose your operating system:

- [Install T3 Code on macOS](/learn/start/install-macos) for the Apple Silicon or Intel desktop app, Homebrew, and the Apple Silicon CLI.
- [Install T3 Code on Windows](/learn/start/install-windows) for the desktop installer, package managers, PowerShell CLI setup, and WSL guidance.
- [Install T3 Code on Linux](/learn/start/install-linux) for Debian packages, AppImages, Arch Linux, Nix, and command-line servers.

Use [the official download page](/download) to find the current release. Follow [Verify the official T3 Code download](/learn/start/verify-official-download) to check the domain, release repository, and available build verification. Do that before running an installer obtained through a search result.

## Connect an agent and a project

The [welcome wizard guide](/learn/start/welcome-wizard) walks through selecting computers, checking Claude Code and Codex, and importing existing projects. The wizard can import recent conversations, but it omits tool activity and attachments. Review the imported context before continuing an important task.

Use the [coding agent guides](/learn/providers) for providers beyond the setup checks. Provider authentication happens on the selected environment's computer. Installing an agent on a phone or another client does not configure the server you are controlling.

After setup, learn to [work with threads](/learn/threads/working-with-threads) and choose [permission modes](/learn/safety/permission-modes). Set up [remote access](/learn/remote/remote-access) when another device needs to reach the same environment.

## Keep your installation working

Read [Update T3 Code](/learn/start/updating) before upgrading connected machines. App and server versions must support the same orchestration protocol. The update notice names the machine that needs attention.

Use the [T3 Code FAQ](/learn/start/faq) for questions about cost, API keys, operating systems, privacy, and mobile apps. It also points to the deeper guide for each decision.

## Next steps

- Choose your installer from [Download T3 Code](/download) and follow the operating-system guide above.
- Complete the [welcome wizard](/learn/start/welcome-wizard), then start with [threads and messages](/learn/threads).
- Return to the [full library](/learn) when you need a guide for another part of T3 Code.
