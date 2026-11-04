---
title: "Use fx in T3 Code"
description: "Install fx for T3 Code, use the host login and model catalog, choose effort and permission modes, and troubleshoot native subagent approval waits."
updated: 2026-11-04
sources:
  - label: "Provider setup"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Permission modes"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md"
  - label: "fx setup and behavior"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-fx.md"
faq:
  - question: "How do I connect fx to T3 Code?"
    answer: "Install fx and run fx login on the machine hosting your T3 Code environment. Enable fx in Settings > Providers and refresh the provider."
  - question: "Can fx instances use separate logins in T3 Code?"
    answer: "Every fx instance on the same machine shares its fx login. T3 Code does not store a separate login for each instance."
  - question: "Which permission modes does fx support in T3 Code?"
    answer: "T3 Code offers fx Supervised and Auto. Saved Full access or Auto-accept edits threads run in Supervised."
  - question: "Why is an fx subagent waiting without an approval prompt?"
    answer: "fx does not forward subagent permission requests to T3 Code. A subagent needing approval waits until you press Stop, most often in Supervised mode."
---

T3 Code runs fx using the login saved on the machine hosting your environment. fx is a coding agent with its own backend and model configuration; install it and sign in on that host before enabling the provider.

## Install fx and connect the host account

1. [Install T3 Code](/download) if needed and select your project environment.
2. Install fx on that environment's machine.
3. Run `fx login` in a terminal on the same machine.
4. Open `Settings > Providers`, enable fx, and refresh the provider.
5. Select fx and its model in a thread.

The documented installation command is:

```bash
curl -fsSL https://fx.sh/setup.sh | bash
```

If `fx` is outside the server's `PATH`, set `Binary path` to its executable. A path on your client device does not help an fx process running on another server. Follow [remote access](/learn/remote/remote-access) before configuring a remote environment.

Every fx instance on one machine shares that machine's login. Adding an instance does not create a separate account. The documented T3 Code setup uses `fx login`; it does not describe a separate T3-managed fx subscription login or API-key sign-in flow.

## Choose the backend through fx

T3 Code does not expose fx's backend selector. To choose among Codex, Grok, or Vercel AI Gateway, run this on the environment machine:

```bash
fx provider
```

This is an fx configuration choice. Selecting fx as your T3 Code provider does not select a backend independently of that host configuration. If the available model list does not match your expectation, check the backend in fx before adding custom model IDs.

## Select a model and effort

The model picker puts `Default` first. That option uses the model reported by `fx status` on the server. A model configured only for one project in fx settings is not picked up, so select it explicitly from the picker instead.

Other models come from `fx models`. If the thread's backend does not offer a chosen model, the thread keeps its current model. A custom model entered in provider settings is passed through as written; fx returns an error when its backend does not provide it.

| Selection    | What to check                              |
| ------------ | ------------------------------------------ |
| Default      | The model shown by `fx status` on the host |
| Listed model | Whether the active fx backend offers it    |
| Custom model | The exact ID accepted by that backend      |
| Effort       | New threads begin at Medium                |

The Effort setting is separate from choosing a backend or model. Confirm all three when comparing results across threads.

## Choose Supervised or Auto permissions

Supervised asks before file changes and commands, while reads proceed without asking. Auto lets fx handle routine actions itself and forwards the requests it still asks about.

Full access and Auto-accept edits are unavailable. A thread already saved in either mode runs in Supervised. Changing modes restarts the connection and reloads the same fx session.

On fx versions containing the documented permission-default persistence change, fx saves the mode set by T3 Code as its default. T3 Code sets that mode whenever it opens an fx thread. A later terminal session can therefore start with that thread's mode. Check the mode when moving between the app and terminal rather than assuming the terminal retained an earlier default.

Read [permission modes](/learn/safety/permission-modes) alongside these provider-specific limits. Auto is fx's native handling of routine work, with remaining prompts still sent to you.

## Use skills and steer active work

Type `$` to list the skills fx finds. T3 Code preserves fx's own folder order, starting with the workspace. When duplicate names exist, the menu shows the copy fx loads first.

The menu groups names without case distinctions. If two skill names differ only in case, type the exact name to invoke the intended one.

A message steered into a running fx turn stops that turn. fx then answers the new message in the same session. Account for that interruption when sending a correction during a long task.

## Diagnose subagent waits and unavailable features

fx subagents appear in their own threads under the parent. Their task and shortened reply are visible, but individual internal steps are not shared.

Subagent permission requests are not forwarded. A child that needs permission waits until you press Stop. This is most common in Supervised. Auto lets children complete routine work without those requests, subject to fx's own decisions.

Plan mode is unavailable. fx also cannot provide T3 Code's app-owned thread titles, branch names, commit messages, or pull request text. Configure another text-generation-capable provider for those actions rather than treating a successful fx chat as proof it supports them.

## Next steps

- Return to [coding agents](/learn/providers) to compare providers with different approval modes.
- Read the [ACP agent guide](/learn/providers/acp-agents) for the generic command connection path.
- Use [working with threads](/learn/threads/working-with-threads) to organize fx tasks and parent conversations.
