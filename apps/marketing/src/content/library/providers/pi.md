---
title: "Use Pi in T3 Code"
description: "Connect your Pi installation to T3 Code with its existing models, login, skills, and extensions, then check native sessions and tool approval behavior."
updated: 2026-11-04
sources:
  - label: "Provider setup"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Permission modes"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md"
  - label: "Pi setup and native sessions"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-pi.md"
  - label: "Pi history import"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/welcome-wizard.md"
  - label: "Pi usage directories"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md"
  - label: "Provider runtime constraints"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/providers.md"
faq:
  - question: "What Pi version does T3 Code support?"
    answer: "T3 Code supports Pi 0.80.5 or newer. Pi requires Node.js 22.19 or newer, and its platform installers can install Node when needed."
  - question: "How do I authenticate Pi for T3 Code?"
    answer: "Run pi and then /login on the environment machine, or configure your model provider's API key. T3 Code uses Pi's existing authentication and model configuration."
  - question: "Does Pi have Auto permission mode in T3 Code?"
    answer: "No. T3 Code offers Pi Supervised, Auto-accept edits, and Full access. Pi does not expose an AI approval reviewer, so stored Auto threads behave as Supervised."
  - question: "Why are Pi project skills missing in T3 Code?"
    answer: "Pi can skip project configuration when the folder is untrusted. Run the configured Pi binary in the same folder and environment, trust it with /trust, and start a new T3 Code thread in that worktree."
---

T3 Code runs your existing Pi installation while keeping its authentication, models, extensions, skills, and native session history. Pi is a coding agent that T3 Code launches in RPC mode on the selected environment.

## Install Pi and connect its model provider

1. [Install T3 Code](/download) and select the environment machine.
2. Install [Pi](https://pi.dev) 0.80.5 or newer there with Node.js 22.19 or newer.
3. Run `pi`, then `/login` to connect your model provider, or configure its API key.
4. Enable Pi in `Settings > Providers` and refresh the provider.
5. Start a thread with one of the models Pi reports.

Pi's platform installers can install Node when required. The documented npm alternative is:

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Set `Binary path` when `pi` is not on the server's `PATH`. Authentication belongs to Pi and its selected model provider. T3 Code does not establish that every provider available in Pi has the same subscription or API-key requirements.

On a headless server, run Pi through SSH and start `/login`. Open the authorization URL on your own computer. If the callback cannot reach the server, paste the final redirect URL or code back into Pi when it asks. API-key variables can also go in the instance's environment settings; mark secrets Sensitive.

## Keep Pi configuration under Pi's control

Provider environment variables and launch arguments support custom agent directories, endpoints, and model configuration. If you pass `--provider`, pair it with `--model`. T3 Code rejects arguments that select a session or change the execution mode because it owns those parts of the process lifecycle.

Use `pi update` for an installer-managed installation. When a package manager owns Pi, update through that manager instead. This avoids treating every installation as if it had the same update path.

T3 Code discovers models and supported thinking levels from Pi. The active model's configured thinking level appears as its default. Other models retain their Pi default when you leave the level unselected.

## Continue native sessions and import history

Pi's session files back resume, rollback, and forks within the same instance. A fork preserves the native conversation through the selected turn in its destination workspace. Switching to another provider uses portable conversation context instead.

The [welcome wizard](/learn/start/welcome-wizard) can import Pi history after you enable Pi and reopen `/welcome`. It imports the active branch that Pi itself reopens. The import follows configured Pi session directories rather than assuming every instance uses the default home.

For usage reporting, the default history location is `~/.pi/agent/sessions`, or `sessions` under `PI_CODING_AGENT_DIR`. Set `PI_CODING_AGENT_SESSION_DIR` when sessions live elsewhere, including a custom `--session-dir` or Pi `sessionDir` setting. Read [Usage and limits](/learn/customize/usage-and-limits) when native work is missing from totals.

## Choose approvals for Pi tools

| Mode              | Pi behavior                                                                       |
| ----------------- | --------------------------------------------------------------------------------- |
| Supervised        | Asks before commands, file changes, and extension tools; read-only tools continue |
| Auto-accept edits | Allows Pi edit and write tools; asks before commands and extension tools          |
| Full access       | Allows tools without T3 Code approval prompts                                     |

Pi does not expose an AI approval reviewer, so Auto is not offered. An older thread that stored Auto displays and behaves as Supervised.

Changing the permission mode restarts the provider session and resumes the same native conversation. The policy applies through Pi's blocking tool hook. It is not an operating-system sandbox. Trusted extension code running outside a tool call remains governed by Pi's extension trust model. Consult [permission modes](/learn/safety/permission-modes) when selecting the thread's controls.

## Load skills and extension dialogs

Pi's user and project skills appear in the composer's `$` menu. Choosing one uses Pi's native expansion. Normal user extensions load, and project extensions load after Pi trusts the folder.

Blocking select, confirm, input, and editor dialogs appear in T3 Code. Notifications appear in the work log. Terminal titles, status lines, and widgets have no matching T3 Code display.

T3 Code's delegation tool creates durable child threads. Pi's example subagent extension can also show task progress and results, but its children run without sessions. Those children cannot be opened or resumed as T3 Code threads.

## Fix trust and discovery problems

If models are missing, open Pi directly and check authentication and model configuration. When discovery cannot complete, T3 Code retains `Pi default`; starting a thread lets the interactive session handle startup prompts.

A first-turn notice can report skipped project settings, extensions, or skills because the folder is untrusted. Run the configured Pi binary in that folder using the same environment, including `PI_CODING_AGENT_DIR` when configured. Use `/trust` for the folder or parent, then start a new thread in that worktree. Arguments containing `--no-approve` intentionally keep project files off without that notice.

## Next steps

- Compare [coding agents](/learn/providers) and the separate [ACP integration](/learn/providers/acp-agents).
- Read [portable handoffs](/learn/threads/portable-handoffs) before switching away from native Pi sessions.
- Use [messages and context](/learn/threads/messages-and-context) to prepare the next task.
