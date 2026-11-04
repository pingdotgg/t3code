---
title: "Use Codex in T3 Code"
description: "Connect Codex to T3 Code through ChatGPT or an existing CLI login, switch compatible accounts, and handle questions, app access, and usage limits."
updated: 2026-11-04
sources:
  - label: "Provider setup"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Permission modes"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md"
  - label: "Codex setup and accounts"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-codex.md"
  - label: "Model discovery"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/model-manifest.md"
faq:
  - question: "Can I use my ChatGPT plan in T3 Code?"
    answer: "T3 Code offers Connect with ChatGPT during onboarding and in Settings > Providers. It installs Codex for that connection and asks you to sign in with OpenAI and allow plan sharing."
  - question: "Does connecting ChatGPT change my Codex CLI login?"
    answer: "Connecting accounts through T3 Code leaves your existing Codex CLI login unchanged. T3 Code also supports a separate path that uses your installed Codex and its existing login."
  - question: "Can I switch Codex accounts in an existing thread?"
    answer: "T3 Code offers compatible accounts in the model picker. For multiple CLI instances, they must share the thread's CODEX_HOME path to continue it."
  - question: "What happens when Codex reaches a usage limit?"
    answer: "T3 Code shows the exhausted window and reset time when Codex reports them. Send the message again after the reset."
---

T3 Code connects Codex through your ChatGPT plan or an existing Codex CLI login. Codex is OpenAI's coding agent; choose the connection path for the environment where you want it to work.

## Connect Codex with your ChatGPT plan

1. [Download T3 Code](/download) and open onboarding or `Settings > Providers`.
2. Select the environment first if your project runs remotely.
3. Choose the ChatGPT connection and let T3 Code handle Codex installation.
4. Sign in on OpenAI and allow sharing of your ChatGPT plan.
5. Select the connected account from the thread's model picker.

Use `Manage usage` in T3 Code to manage the shared usage and credits in ChatGPT. Some requests use features that ChatGPT sharing does not support. Use another provider for those requests rather than assuming every Codex capability is available through sharing.

When reconnecting, choose the same account in T3 Code and on OpenAI's sign-in page. Disconnecting stops running threads but keeps their history, so you can reconnect later. The [ChatGPT plan guide](/learn/concepts/use-your-chatgpt-plan) explains this connection separately from a CLI account.

## Use Codex already installed on your environment

T3 Code can use your existing Codex executable and login. Run this on the machine hosting the environment:

```bash
codex login
```

Enable that provider in `Settings > Providers`, check its executable path, and refresh status. Use `Binary path` when the CLI is outside the server's `PATH`. The [welcome wizard](/learn/start/welcome-wizard) can check installation and authentication during first run.

Managed ChatGPT connections leave the CLI login unchanged. Keep that distinction in mind when troubleshooting an account mismatch: inspect the connection you selected, not only the account you see in a terminal.

## Configure separate accounts without losing thread access

For another managed account, add it in `Settings > Providers` and select it from the model picker. Compatible accounts can continue the same thread.

Multiple CLI logins have two directory choices. A shared home with a shadow home shares sessions and configuration while retaining a separate login and available models. Completely separate homes isolate sessions and configuration.

To prepare a second CLI login:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

Then configure the two instances:

| Instance | `CODEX_HOME path` | `Shadow home path`  |
| -------- | ----------------- | ------------------- |
| Work     | `~/.codex`        | Empty               |
| Personal | `~/.codex`        | `~/.codex_personal` |

The second instance still uses the shared `CODEX_HOME path`. T3 Code prepares shared state in the shadow directory. Do not copy the whole first home into it. The shadow account needs its own `auth.json`; when Codex uses an OS credential store, configure file storage for this arrangement.

Use a different `CODEX_HOME path` without a shadow home when you want separate sessions. That instance cannot continue threads from the first home. [Claude Code account isolation](/learn/providers/claude-code) uses a different directory model.

## Respond to approvals and questions

Codex supports automatic review through Auto permission mode. Select the mode in the composer and use [permission modes](/learn/safety/permission-modes) to decide when commands and edits require input.

Codex can also request access to another app. Respond to the named app's request in the thread on web, desktop, or mobile. Depending on the tool, access can apply to one request, the session, or permanently. App access and command approval are separate decisions.

On versions supporting async questions, Codex can ask and keep working. Answer from the thread's question panel. Your answer becomes a message that reaches active work or starts another turn after it finishes. Unanswered questions survive reconnects. Dismissing a question closes it without sending a message.

## Fix account, model, and remote login problems

If an account is absent from an existing thread's picker, compare its home path with the thread's home. If both instances show an unexpected account or catalog, refresh status and check the second instance's shadow path and login. Use a fresh directory if a copied setup caused a shadow-home conflict.

Codex's model list comes from its app server. T3 Code can identify models requiring a newer CLI and show the update needed to unlock them. Check provider status before treating a missing model as a sign-in failure.

When remote sign-in cannot return automatically, paste the full URL from the final localhost page into the sign-in panel. Use the full address even when that page cannot load on your device.

When usage runs out, T3 Code names the window and reset time if Codex supplies them. On a workspace plan, it can also say whether the owner needs credits or a higher spend limit. Retry the message after reset. [Usage and limits](/learn/customize/usage-and-limits) separates these limits from API-equivalent cost estimates.

## Decide whether to send diagnostic feedback

Sending `/feedback` in an existing Codex thread uploads the conversation and Codex logs to OpenAI. You can include a description after the command. The returned thread ID can be shared with OpenAI support. Use this when you intend to submit those diagnostics.

## Next steps

- Compare [Claude Code, Codex, and Cursor](/learn/concepts/claude-code-vs-codex-vs-cursor) or review [Grok's connection](/learn/providers/grok).
- Read [portable handoffs](/learn/threads/portable-handoffs) before transferring context to another agent.
- Return to [coding agents](/learn/providers) for all providers, including the [generic ACP path](/learn/providers/acp-agents).
