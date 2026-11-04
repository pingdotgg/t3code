---
title: "Use Grok in T3 Code"
description: "Connect Grok Build to T3 Code through its installed CLI, verify cached login or API-key authentication, and understand model discovery and approvals."
updated: 2026-11-04
sources:
  - label: "Provider setup"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Permission modes"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md"
  - label: "Grok provider settings"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/provider-grok/src/settings.ts"
  - label: "Grok status and authentication probes"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/provider-grok/src/server/status.ts"
  - label: "Grok ACP authentication and permission options"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/provider-grok/src/server/acpSupport.ts"
  - label: "Grok adapter behavior"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/provider-grok/src/server/adapter.ts"
  - label: "Grok subscription reporting"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/provider-grok/src/server/usageLimits.ts"
  - label: "Usage and limits"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md"
faq:
  - question: "How do I connect Grok to T3 Code?"
    answer: "Install Grok Build CLI on the environment machine and run grok login. Enable Grok in T3 Code Settings > Providers and set Binary path if the executable is outside PATH."
  - question: "Can T3 Code use a Grok API key?"
    answer: "Yes. The Grok adapter selects xAI API-key authentication when XAI_API_KEY is nonempty. Otherwise T3 Code selects cached-token authentication."
  - question: "Does Grok support Auto-accept edits in T3 Code?"
    answer: "No. T3 Code offers Grok Supervised, Auto, and Full access. A saved Auto-accept edits thread behaves as Supervised."
  - question: "Why are Grok models incomplete?"
    answer: "T3 Code discovers Grok models from CLI output and ACP initialization. A failed or timed-out ACP initialization produces a warning that model options may be incomplete."
---

T3 Code connects Grok Build through the installed Grok CLI and its ACP transport. Grok Build is xAI's coding agent; T3 Code uses a cached Grok login or an explicit `XAI_API_KEY` on the selected environment.

## Install Grok on the environment machine

1. [Install T3 Code](/download), then select the environment containing your project.
2. Install Grok Build CLI from [xAI's CLI distribution](https://x.ai/cli) on that machine.
3. Run `grok login` in a terminal there.
4. Open `Settings > Providers` and enable Grok.
5. Refresh provider status before selecting Grok for a thread.

Grok is disabled by default in its provider settings. Its executable defaults to `grok`. Set `Binary path` to the installed executable when it is not on the environment server's `PATH`.

The status check distinguishes a missing command, an execution failure, and a timeout. Test `grok --version` on the same environment when installation status is unclear. A working executable on another computer does not establish that the selected environment can launch it.

## Choose cached login or an API key

The adapter selects API-key authentication when `XAI_API_KEY` contains a nonempty value. Add that variable to the provider instance's environment settings and mark the value Sensitive. With no explicit key, the adapter selects cached-token authentication.

T3 Code's status check uses `grok models` to inspect model names and login state without creating an agent session. When the CLI reports no login, the provider message directs you to run `grok login`. An API-key connection is labeled separately from a Grok account connection.

This establishes two authentication paths, but it does not establish a particular subscription tier's eligibility or pricing. Use the account access reported by Grok rather than assuming a login grants every model.

## Check models and reasoning options

T3 Code reads model information from ACP initialization and falls back to CLI model output. If neither provides a model list, it retains a built-in Grok Build entry and warns that model options may be incomplete.

Grok Build is a product selection that keeps the session's current model. It is not a promise of a fixed underlying model ID. Reasoning controls depend on the options Grok advertises for each model. T3 Code also accepts custom model entries in provider settings.

If provider status warns about ACP initialization, distinguish that warning from a login error. A CLI can be installed while model discovery remains incomplete. Refresh status after resolving the launch or authentication problem, then inspect the available catalog again.

## Select a Grok permission mode

| Mode        | Grok behavior                                                   |
| ----------- | --------------------------------------------------------------- |
| Supervised  | Launches with the default asking mode                           |
| Auto        | Uses Grok's native automatic review; blocked requests reach you |
| Full access | Launches with Grok's always-approve behavior                    |

Grok has no Auto-accept edits mode. A thread saved with that mode runs as Supervised. Explicit approval or sandbox policy overrides cause the adapter to launch in asking mode so native automatic behavior cannot bypass T3 Code's checks.

File-change requests can offer `Allow all edits this session`. Command requests do not get a session-wide choice because Grok would remember that command for the whole project. Choose the request-specific option when you want a narrower grant.

Read [permission modes](/learn/safety/permission-modes) before carrying expectations from [Codex](/learn/providers/codex) into a Grok thread. The shared composer does not make their native review behavior identical.

## Understand compaction and conversation limits

The adapter enables manual compaction and advertises `/compact` among the available commands. It does not advertise conversation rollback or the separate Plan and Build interaction toggle.

T3 Code can present Grok questions and tool activity through its ACP integration. That connection is a dedicated provider implementation; it differs from adding an arbitrary agent through the [ACP Registry path](/learn/providers/acp-agents).

Do not use a status refresh as a login action. The Grok probe deliberately avoids authentication calls and session creation. Its purpose is to inspect readiness without launching login browsers or workspace MCP servers.

## Diagnose missing usage and limits

T3 Code can report the current subscription allowance and reset time for the normal saved-login path. Explicit API keys and custom authentication or endpoint configurations do not report subscription limits through this reader.

The usage reader can also report a Privacy Mode requirement from xAI. Follow that specific account message when it appears. Missing limit information does not establish unlimited use.

Historical totals depend on completed-turn records. Grok turns without a saved completed-turn record are absent from totals. Read [Usage and limits](/learn/customize/usage-and-limits) before comparing estimates with your subscription bill.

## Next steps

- Return to [coding agents](/learn/providers) to compare connection paths.
- Use the [threads guide](/learn/threads/working-with-threads) to start a bounded task after status is ready.
- Review [remote access](/learn/remote/remote-access) when Grok runs on a different machine from your interface.
