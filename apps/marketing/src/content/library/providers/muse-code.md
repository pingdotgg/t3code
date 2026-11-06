---
title: "Use Muse Code in T3 Code"
description: "Connect Muse Code to T3 Code with a host login or instance API key, refresh models, choose approval modes, and troubleshoot access and session limits."
updated: 2026-11-04
sources:
  - label: "Provider setup"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Permission modes"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md"
  - label: "Muse Code setup and limitations"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-muse.md"
  - label: "Muse usage history"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md"
  - label: "Theo introduces Muse Code"
    url: "https://www.youtube.com/watch?v=-Gj0-EIyx6g&t=61s"
faq:
  - question: "How do I connect Muse Code to T3 Code?"
    answer: "Install Muse Code on the environment host and run muse login as the account running T3 Code. Enable Muse Code in Settings > Providers and refresh provider status."
  - question: "Can T3 Code use META_API_KEY for Muse?"
    answer: "Yes. Add META_API_KEY explicitly to the Muse instance's environment variables. T3 Code ignores a key merely inherited by the server, and an explicit instance key takes priority over saved login."
  - question: "Why does Muse fail after T3 Code says it is installed?"
    answer: "Muse provider status does not verify login. Run muse login on the host, then refresh T3 Code provider status and retry with an available model."
  - question: "Does Muse support Plan mode or rewind in T3 Code?"
    answer: "No. T3 Code offers Muse Supervised and Full access, but no separate Plan mode or conversation rewind. Forking creates a new session with copied conversation context."
---

T3 Code runs Muse Code from an installation on the machine hosting your environment. Muse Code is Meta's coding agent; authenticate it on that host with `muse login` or an explicit instance API key before sending messages.

## Install Muse Code and enable the provider

1. [Install T3 Code](/download) and select the environment where your project lives.
2. Install Muse Code on that environment's machine through its [installation guide](https://dev.meta.ai/docs/muse-code).
3. Run `muse login` as the account that runs T3 Code.
4. Open `Settings > Providers` in web or desktop and enable Muse Code.
5. Refresh provider status, then choose Muse from the thread's model picker.

Muse Code is disabled by default. If its executable is outside the host's `PATH`, set `Binary path` to the executable on that host.

In-app Muse installation and sign-in are unavailable. Provider status also does not test whether you are logged in. A provider can appear installed while messages fail because the host account is signed out. Verify `muse login` before treating that failure as a T3 Code connection problem.

## Choose host login or an explicit API key

T3 Code ignores `META_API_KEY` inherited from the server's own environment. This allows Muse to use the credential saved by `muse login` on the host.

To use an API key, add `META_API_KEY` explicitly under the Muse instance's environment variables in `Settings > Providers`. Muse gives that key priority over the saved login. Mark the value Sensitive so provider settings do not display it after saving.

| Account goal                     | Configuration                      |
| -------------------------------- | ---------------------------------- |
| Use the host's saved Muse login  | Run `muse login` on the host       |
| Use an API key for one instance  | Add that instance's `META_API_KEY` |
| Bill another instance separately | Give it its own instance API key   |

Instances on the same host share the host's Muse login. Creating another instance provides a separate configuration, but does not establish a separate saved login by itself.

## Connect from another device

Web, desktop, and mobile can connect through [remote access](/learn/remote/remote-access). Muse works with the files and login of the selected environment. A connecting phone or browser device does not need Muse installed.

Install and authenticate Muse separately on each host where it should run. When a task fails remotely, inspect the environment's login and binary path rather than the connecting device's terminal configuration.

Existing conversations retain their provider instance when its model catalog becomes unavailable. This keeps the association with the chosen configuration; it does not establish that the saved model remains accessible.

## Refresh models and resolve access errors

Models and reasoning options come from Muse on the selected host. Refresh provider status after changing its configuration. On mobile, pull down in thread settings to refresh models.

If a saved model becomes unavailable, choose an available one before sending again. Muse can also report models that the account cannot use. An error saying the model does not exist or you lack access calls for another accessible model, or an exact account-supported ID under `Custom models` in instance settings.

Do not treat catalog presence as account entitlement. The model list, saved thread selection, and permission to execute that model are separate checks.

## Choose Muse approvals and understand session limits

Muse offers two permission modes. Supervised asks before commands and file edits. Full access runs those actions without asking. Auto and Auto-accept edits have no Muse equivalent and are not offered. A thread already saved in another mode runs as Supervised.

Muse also lacks a separate Plan mode in T3 Code. Review [permission modes](/learn/safety/permission-modes) before carrying another provider's mode expectations into a Muse thread.

Muse can use T3 Code tools, but a turn continues without them if it cannot reach them. Check tool availability when a task depends on those capabilities rather than assuming every successful answer had access to them.

Forking creates a new session with copied conversation context. Conversation rewind is unavailable. Switching providers can pass context through a handoff; read [portable handoffs](/learn/threads/portable-handoffs) before relying on that context for exact instructions.

## Manage skills, updates, and usage

Muse skills do not appear in the composer's `$` menu. Muse still loads them itself. Use `muse skills` on the host to manage them. An empty T3 Code skill picker does not establish that Muse has no skills.

Updates can run from `Settings > Providers` when T3 Code recognizes the Muse launcher. Otherwise update the host installation manually. Disabling Muse in provider settings retains the host login, thread history, and workspace files.

Usage reads native session history, including child sessions, from the home reported by the configured Muse CLI. Instance environment settings such as `XDG_DATA_HOME` apply. Models without known prices still contribute tokens as unpriced entries. [Usage and limits](/learn/customize/usage-and-limits) explains how to assign custom estimates.

## Next steps

- Return to [coding agents](/learn/providers) to compare connection and account behavior.
- Read the [generic ACP agent guide](/learn/providers/acp-agents) for other agent integrations.
- Use the [threads guide](/learn/threads/working-with-threads) to start a task after confirming model access.
