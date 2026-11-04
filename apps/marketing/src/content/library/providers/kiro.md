---
title: "Use Kiro in T3 Code"
description: "Install and authenticate Kiro for T3 Code, select models and custom agents, and understand supervised reviews, steering, forks, and compaction."
updated: 2026-11-04
sources:
  - label: "Provider setup"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Permission modes"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md"
  - label: "Kiro setup, models, and permissions"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-kiro.md"
faq:
  - question: "How do I connect Kiro to T3 Code?"
    answer: "Install Kiro CLI and run kiro-cli login on the environment machine. Enable Kiro in T3 Code Settings > Providers and refresh its status."
  - question: "Can T3 Code use a Kiro API key?"
    answer: "Kiro Pro and higher plans can set KIRO_API_KEY in the T3 Code Kiro instance's environment variables. The documented alternative is kiro-cli login on the host."
  - question: "Which permission modes does Kiro offer in T3 Code?"
    answer: "T3 Code offers Supervised and Full access for Kiro. Supervised also requires review of the turn's file changes; Auto and Auto-accept edits are unavailable."
  - question: "Where does T3 Code find custom Kiro agents?"
    answer: "T3 Code lists Kiro agents under ~/.kiro/agents along with built-in agents. Project agents in .kiro/agents are not listed yet."
---

T3 Code runs Kiro CLI with your Kiro account, custom agents, steering, hooks, and MCP configuration. Kiro is a coding agent whose CLI V3 engine must work on the machine hosting your T3 Code environment.

## Install and authenticate Kiro on the host

1. [Install T3 Code](/download) and select the environment for your project.
2. Install [Kiro CLI](https://kiro.dev/docs/cli/) on that environment's machine.
3. Run `kiro-cli login` in a terminal there.
4. Open `Settings > Providers` and enable Kiro.
5. Refresh provider status before selecting Kiro in a thread.

For macOS or Linux, the documented installation command is:

```bash
curl -fsSL https://cli.kiro.dev/install | bash
```

For Windows 11, use PowerShell:

```powershell
irm 'https://cli.kiro.dev/install.ps1' | iex
```

Kiro Pro and higher plans can use an API key instead of the terminal login. Set `KIRO_API_KEY` in the Kiro instance's environment variables. Mark secret values Sensitive in provider settings.

If the executable is outside the server's `PATH`, configure `Binary path`. On macOS and Linux, the installer usually places it under `~/.local/bin`. The executable is `kiro-cli`, rather than the display name Kiro.

For remote work, installation and login belong to the server, even when you use a browser or phone elsewhere. Follow [remote access](/learn/remote/remote-access) to connect that environment before configuring its provider.

## Verify that Kiro can run its V3 engine

T3 Code starts Kiro's CLI V3 engine. A CLI that cannot run V3 cannot start this integration. Check the executable and installed Kiro version on the environment before treating startup failure as a model problem.

Provider status and model selection answer different questions. First establish that the environment can launch the CLI. Then check authentication and refresh the provider to inspect the models your account can access.

## Choose a model and reasoning setting

The picker lists models available to the signed-in Kiro account. New threads use the account's Kiro default, normally `auto` unless the account or organization sets another model. Auto lets Kiro choose.

Selecting a model your account cannot use stops the turn with an error. Kiro does not silently substitute another model. Pick an available entry rather than assuming a failed selection fell back successfully.

Some models expose adjustable reasoning. The `Reasoning` control lists only levels Kiro offers for that model. The default model and models without effort control keep Kiro's own setting.

## Pick a Kiro agent for the task

The `Agent` option next to the model selects Kiro's built-in agents, including Spec and Plan, and custom agents in `~/.kiro/agents`. Refresh the provider after adding or removing one.

Project-level `.kiro/agents` are not listed yet. If a custom agent is missing, check its location before repeatedly refreshing. The supported user-agent directory and the project directory are not interchangeable for this picker.

The thread's selected model still applies when an agent defines its own `model`. If an agent was removed, the thread stays on Kiro's current agent. Recheck both selections when resuming older work.

## Choose between approval and automatic execution

| Mode        | Tool requests                            | Turn completion                           |
| ----------- | ---------------------------------------- | ----------------------------------------- |
| Supervised  | Sends writes and command requests to you | Kiro also asks you to review file changes |
| Full access | Approves tool requests automatically     | Autopilot remains on with no review step  |

Kiro does not offer Auto or Auto-accept edits. In Supervised, Autopilot is off, which accounts for the additional review before the turn finishes.

Approval choices come from Kiro. `Always allow` saves a workspace-wide rule, so T3 Code shows it only when Kiro offers no one-time choice. Consider that scope before accepting a request that could affect later work in the same workspace. Read [permission modes](/learn/safety/permission-modes) for the shared composer controls.

## Steer work, fork a thread, and compact history

A text message sent while Kiro works joins the active turn. Kiro reads it after the current step or tool call finishes. A message with images instead stops the turn and begins another with those images.

Forking from a message gives the fork Kiro's native copy of the conversation through that message. This differs from the summarized context used by some provider switches. Read [portable handoffs](/learn/threads/portable-handoffs) before moving work to another provider.

Send `/compact` to use Kiro's own compaction. Kiro also compacts automatically as the conversation fills its context. These are Kiro session behaviors; choosing another model or provider is a separate action.

## Next steps

- Compare Kiro with [other coding agents](/learn/providers) and the [generic ACP path](/learn/providers/acp-agents).
- Use the [threads guide](/learn/threads/working-with-threads) to organize tasks after connecting.
- Read [project settings](/learn/customize/project-settings) alongside your chosen default permission mode.
