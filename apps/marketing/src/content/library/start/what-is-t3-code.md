---
title: "What is T3 Code?"
description: "Understand what T3 Code does, which coding agents it runs, how it uses your existing accounts, and why it is a control plane rather than a harness."
updated: 2026-11-04
sources:
  - label: "T3 Code overview"
    url: "https://github.com/pingdotgg/t3code/blob/main/README.md"
  - label: "T3 Code FAQ"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/faq.md"
  - label: "Installation and supported providers"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Cursor SDK runtime"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/cursor.md"
  - label: "MIT license"
    url: "https://github.com/pingdotgg/t3code/blob/main/LICENSE"
  - label: "Official product and organization metadata"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/marketing/src/lib/seo.ts"
  - label: "Theo on harnesses at 6:02"
    url: "https://www.youtube.com/watch?v=xJaMTo2YgO8&t=362s"
  - label: "Alpha launch at 1:01"
    url: "https://www.youtube.com/watch?v=hDn8-fK3XaU&t=61s"
  - label: "Agent overview at 5:00"
    url: "https://www.youtube.com/watch?v=uLGxb4F3SyI&t=300s"
faq:
  - question: "What is T3 Code?"
    answer: "T3 Code is a free, MIT-licensed, open-source control plane for coding agents built by T3 Tools Inc. It runs agents such as Claude Code, Codex, Cursor, and OpenCode through desktop, web, and mobile clients."
  - question: "Is T3 Code an AI model?"
    answer: "T3 Code is an application for controlling coding agents. The agent provider supplies the model and runtime you use."
  - question: "Is T3 Code a harness?"
    answer: "T3 Code uses provider harnesses such as Claude Code and Codex. It is not a replacement harness and does not work without one."
  - question: "Do I need a T3 Code subscription?"
    answer: "T3 Code is free and MIT licensed. You bring your provider subscription or API credentials; T3 Code does not resell tokens."
---

T3 Code is a free, open-source control plane for coding agents, built by T3 Tools Inc and released under the MIT license. It runs Claude Code, Codex, Cursor, OpenCode, and other agents through desktop, web, and mobile clients. T3 Code is not an AI model, a harness, or a paid subscription.

## What does T3 Code control?

T3 Code connects the app you use with agents running on a computer you control. That computer holds the project files, provider configuration, and authentication needed for the work. Your client can be on the same computer or another device.

The desktop app bundles a server. You can also start a server from the command line and use its web app. The mobile apps connect to a server on another machine. This lets you choose where the work runs separately from where you read replies and send instructions.

Use T3 Code when you want to manage work through projects and threads while keeping your chosen agent runtimes. You can configure more than one provider, rather than moving all your work to one provider's desktop application. Learn how that division works in [the control plane guide](/learn/concepts/control-plane-for-coding-agents).

## How is a control plane different from a harness?

A model generates responses. A harness gives that model tools, runs its tool calls, and returns the results. T3 Code uses those harnesses and supplies the interface for directing and reviewing their work.

| Part    | What it does                                                          | What you choose                                 |
| ------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| Model   | Produces the agent's responses                                        | A model offered by your provider                |
| Harness | Gives the model tools and executes its actions                        | A provider runtime such as Claude Code or Codex |
| T3 Code | Controls agents through projects, threads, and connected environments | The client and computer you work from           |

In [his explanation at 6:02](https://www.youtube.com/watch?v=xJaMTo2YgO8&t=362s), Theo Browne says, "T3 Code is not a harness." He also says, "It is not able to be paid for" while distinguishing T3 Code from T3 Chat. Those distinctions help you diagnose setup: an installed T3 Code app still needs a working provider before an agent can answer.

## Which coding agents can you use?

The installation documentation covers Codex, Claude Code, Cursor, Grok Build, Kiro, OpenCode, Antigravity, Pi, Muse Code, and fx. Each has its own setup and authentication requirements. The welcome wizard checks Claude Code and Codex; you enable other providers in Settings.

Most provider CLIs must be available on the server's `PATH`. A missing CLI on that machine can prevent the provider from appearing, even if it works on your laptop. Codex connected through ChatGPT and Antigravity can use managed runtimes without a `PATH` entry. Cursor uses its local SDK runtime rather than launching the Cursor CLI.

Provider instances can hold separate accounts or configurations. Their environment variables can include API keys or custom endpoints. Choose the configuration for the provider you intend to run, rather than treating T3 Code as a universal account or model subscription.

## Is T3 Code free and open source?

T3 Code costs nothing to use. Its MIT license lets you use, modify, and distribute the software under the license's conditions. Read [the MIT license guide](/learn/open-source/mit-license) for that distinction and the source repository.

Provider usage remains separate. You use the subscriptions or API credentials you connect, and provider costs and limits still apply. Installing T3 Code does not supply inference credits or replace those accounts.

At [1:01 in the alpha launch](https://www.youtube.com/watch?v=hDn8-fK3XaU&t=61s), Theo says, "T3 Code is entirely free and open source." That video describes an early release with narrower provider support. Use current setup documentation for available integrations, and watch [the alpha launch overview](/learn/videos/its-finally-here) for the project's original motivation.

## Where should you start?

Install on the computer that will run the agents. Open [Download T3 Code](/download) for desktop builds, or use the documented CLI installer for a command-line server. You can launch the app before configuring a provider.

Then select the environment, enable a provider, and authenticate it there. The [welcome wizard](/learn/start/welcome-wizard) can check your agents and import recent projects. If you are deciding about privacy, keys, or mobile use first, read the [T3 Code FAQ](/learn/start/faq).

## Next steps

- Follow the [Get started guides](/learn/start) to choose an installation path.
- Complete the [welcome wizard](/learn/start/welcome-wizard) after installation.
- Read [the control plane explanation](/learn/concepts/control-plane-for-coding-agents) or the [T3 Code FAQ](/learn/start/faq) for the next decision.
