---
title: "First run: the welcome wizard"
description: "Set up T3 Code with the welcome wizard: select computers, check Claude Code and Codex, import projects, and understand conversation import limits."
updated: 2026-11-04
sources:
  - label: "Welcome wizard"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/welcome-wizard.md"
  - label: "Provider setup and installation"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Updating incompatible environments"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/updating.md"
faq:
  - question: "Why does T3 Code not show the welcome wizard?"
    answer: "Existing T3 Code workspaces skip setup. The hosted app at app.t3.codes also uses its own connection flow rather than opening the welcome wizard."
  - question: "Can I reopen the T3 Code welcome wizard?"
    answer: "Open /welcome in T3 Code to run setup again. You can close setup when no import is running and configure computers or providers later in Settings."
  - question: "Does importing a project copy every conversation detail?"
    answer: "T3 Code imports recent visible user and assistant messages with a 200-message total per conversation. Import omits tool activity and attachments, and skips conversations that exceed documented limits."
  - question: "Why is Pi history missing from T3 Code setup?"
    answer: "Pi is off by default in T3 Code. Enable Pi in Settings, then open /welcome to import sessions from each enabled Pi provider's configured session directory."
---

T3 Code's welcome wizard connects computers, checks Claude Code and Codex, and imports recent projects and conversations. It appears for a new installation; existing workspaces skip it, and you can reopen it at `/welcome`.

## Choose where your agents will run

Before selecting a computer, distinguish the device displaying T3 Code from the machine running your agents. The selected environment owns its files, provider installation, and authentication. A browser on your laptop can control a server elsewhere.

If you have not installed T3 Code yet, use [Download T3 Code](/download) and the [macOS](/learn/start/install-macos), [Windows](/learn/start/install-windows), or [Linux](/learn/start/install-linux) guide. Read [What is T3 Code?](/learn/start/what-is-t3-code) if the client and server distinction is still unclear.

When you open the desktop app or open T3 Code directly from a server, that computer is already connected and selected. Check its displayed name. It may be different from the computer holding your browser.

## Connect the computers you want to set up

1. Review the connected computer and any saved or discovered computers.
2. Add another computer through T3 Connect or a direct pairing link if needed.
3. Clear the checkboxes for computers you do not want to include in setup.
4. Continue once the selected computers are connected.

Unchecking a computer excludes it from these setup checks. It does not disconnect the computer. Setup checks agents across the selected machines, then groups project imports by computer.

| Connection choice        | What to do on the host                                              |
| ------------------------ | ------------------------------------------------------------------- |
| T3 Connect               | Install the CLI, run `t3 connect`, then start T3 Code or `t3 serve` |
| Tailnet pairing          | Start `t3 serve`, then run `t3 pair --tailscale` and paste its link |
| Reachable network server | Start `t3 serve --host <address>`, then use `t3 pair`               |

Follow [remote access setup](/learn/remote/remote-access) for the connection path you choose. A host must stay available for its clients to use it.

The hosted app at `app.t3.codes` follows a different entry path. With no computer connected, it asks you to sign in to T3 Connect and run `npx t3 connect` on the computer. From home, it adds compatible computers linked to your account and opens the app. It does not open the welcome wizard automatically.

## Check Claude Code and Codex on each computer

The wizard checks whether Claude Code and Codex are installed and signed in. Select the offered action to open a terminal with the appropriate command ready to run. Installation uses the vendor's installer so provider updates remain available in Settings.

The terminal uses the selected provider instance's home directory and environment. Sensitive values stay redacted in Settings and terminal metadata, while the process can use them.

Use [Claude Code setup](/learn/providers/claude-code) or [Codex setup](/learn/providers/codex) if authentication needs attention. Enable other providers later in `Settings → Providers`. You can finish setup without configuring an agent, but you need a working provider before starting an agent thread.

## Select projects to import

T3 Code finds directories used by Claude Code, Codex, or Pi. Git repositories appear first, sorted by recent activity. Repositories with a GitHub remote show `owner/name`, and clones with the same remote share a group. Non-Git directories appear under `Other folders`.

The default selection includes Git repositories active within the last 30 days with at least three conversations. Use the checkboxes, `Select all`, or `Select none` to change it. Do not treat the default selection as a requirement to import every project.

Linked worktrees of bare repositories can appear as separate projects. Other linked Git worktrees, Codex scratch directories under `Documents/Codex`, and directories under `Downloads` are not offered. A warning about a scan limit means the list can be incomplete, even when some projects appear.

## Understand what conversation import keeps

Selected projects include Claude, Codex, and Pi conversations active within the last 30 days. Each imported conversation keeps the first user prompt and the newest remaining visible user and assistant messages, with 200 messages total. Tool activity and attachments are omitted.

Pi is disabled by default. Enable it in Settings, then reopen `/welcome` to import its sessions. T3 Code uses each enabled Pi instance's session directory and imports the conversation's active branch.

Import reads one conversation at a time. It skips files larger than 4 GiB and conversations whose retained text and metadata need more than 32 MiB. Each attempt reads up to 100 conversation files and 4 GiB per project, with up to 100,000 input records.

Run import again for the rest of a large batch. Completed conversations are not imported again. Review a conversation's visible history before continuing a task that depended on omitted tool output or attachments.

## Resolve setup errors or continue later

`Client not supported` means that computer's version cannot communicate with this app. The message names the side to update. Follow [Update T3 Code](/learn/start/updating) rather than reinstalling providers to fix a client protocol mismatch.

For `Still connecting`, select `Reload`. For `Could not read settings`, select `Retry` once storage is available. T3 Code does not replace unreadable settings with defaults.

You can return to an earlier step through the setup progress bar. Navigation pauses while import runs. When no import is running, close setup to enter the app and configure the rest later.

## Next steps

- Use [Get started](/learn/start) and [work with threads](/learn/threads/working-with-threads) to begin a task.
- Read the [T3 Code FAQ](/learn/start/faq) for provider, privacy, and mobile questions.
- Keep [update instructions](/learn/start/updating) available when adding computers with older versions.
