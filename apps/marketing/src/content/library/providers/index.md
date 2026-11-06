---
title: "Choose a coding agent for T3 Code"
description: "Compare coding agents in T3 Code by connection, authentication, and supported workflow, then follow the setup guide for your provider."
updated: 2026-11-04
sources:
  - label: "Provider setup"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Permission modes"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md"
  - label: "Claude Code"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md"
  - label: "Codex"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-codex.md"
  - label: "Cursor SDK integration"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/cursor.md"
  - label: "OpenCode"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-opencode.md"
  - label: "Antigravity"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-antigravity.md"
  - label: "Kiro"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-kiro.md"
  - label: "Pi"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-pi.md"
  - label: "fx"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-fx.md"
  - label: "Muse Code"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-muse.md"
  - label: "ACP agents"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-acp.md"
  - label: "Grok authentication and transport"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/provider-grok/src/server/acpSupport.ts"
  - label: "Provider runtime constraints"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/providers.md"
faq:
  - question: "Which coding agents does T3 Code support?"
    answer: "T3 Code has dedicated providers for Claude Code, Codex, Cursor, Grok, OpenCode, Antigravity, Kiro, Pi, fx, and Muse Code. It also connects ACP Registry agents and installed local ACP commands."
  - question: "Do I need an API key for T3 Code?"
    answer: "T3 Code uses the authentication supported by each provider. Several providers support account sign-in; API-key support and subscription eligibility depend on the selected agent."
  - question: "Where do T3 Code agents run?"
    answer: "T3 Code providers run on the selected environment, which can be a different machine from your browser or phone. Install and authenticate the agent on that environment."
---

T3 Code connects coding agents to projects and threads through provider integrations. Choose an agent you can authenticate on the machine running your environment, then check its permission and conversation limits before starting work.

## Compare how coding agents connect

A provider is the agent runtime T3 Code talks to. It is separate from a model: some providers expose several models or backends. These connections do not imply endorsement by the provider companies.

| Provider                                        | How it connects                                       | Authentication                                                  | Notable capability                               |
| ----------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------ |
| [Claude Code](/learn/providers/claude-code)     | Existing Claude Code installation and configuration   | Claude Code login; API or router variables in the instance      | Claude skills and manual context compaction      |
| [Codex](/learn/providers/codex)                 | Managed ChatGPT connection or installed Codex CLI     | ChatGPT sharing or existing CLI login                           | Compatible accounts can continue the same thread |
| [Cursor](/learn/providers/cursor)               | Local agent through `@cursor/sdk`                     | Browser sign-in or `CURSOR_API_KEY`, with a paid Cursor plan    | Streams plans, todos, and native task activity   |
| [OpenCode](/learn/providers/opencode)           | T3-started local server or configured external server | OpenCode authentication; separate server password               | Supports OpenCode 1.x and 2.x                    |
| [Grok](/learn/providers/grok)                   | Installed Grok CLI over ACP                           | Cached Grok login or `XAI_API_KEY`                              | Native automatic review in Auto mode             |
| [Antigravity](/learn/providers/antigravity)     | Managed or manual Antigravity ACP runtime             | Google, Gemini Enterprise, Gemini API key, or Vertex AI methods | Separate account profiles per instance           |
| [Kiro](/learn/providers/kiro)                   | Installed Kiro CLI V3 engine                          | CLI login or `KIRO_API_KEY` on Pro and higher                   | Selects built-in and user Kiro agents            |
| [Pi](/learn/providers/pi)                       | Installed Pi in RPC mode                              | Pi's model-provider login or API key                            | Native session resume, rollback, and forks       |
| [fx](/learn/providers/fx)                       | Installed fx on the environment                       | Shared machine login from `fx login`                            | Uses models and backend configuration from fx    |
| [Muse Code](/learn/providers/muse-code)         | Installed Muse CLI                                    | Host login or instance `META_API_KEY`                           | Models and reasoning choices from the host       |
| [Other ACP agents](/learn/providers/acp-agents) | ACP Registry distribution or local command            | Agent-advertised sign-in or environment keys                    | Discovers the agent's models and options         |

## Pick a provider for your existing setup

Start with the account and configuration you already use. Claude Code keeps Claude's login and skills. Codex offers a managed ChatGPT connection and a separate existing-CLI path. Cursor uses its SDK login rather than inheriting your editor session. Read the [Claude Code, Codex, and Cursor comparison](/learn/concepts/claude-code-vs-codex-vs-cursor) when choosing among those workflows.

Choose OpenCode when you need its existing server connection. Choose Pi when native Pi sessions and extensions matter. Use the dedicated Antigravity, Kiro, fx, and Muse pages to check their setup requirements. Add another ACP agent when its own models, tools, and sign-in fit your task.

## Connect on the correct machine

1. [Download T3 Code](/download) if you have not installed it.
2. Open `Settings > Providers` and select the environment that owns your project.
3. Enable the provider and complete its documented installation and authentication steps.
4. Refresh provider status, then select the provider and model for a thread.

A successful login on your laptop does not establish a login on a remote server. A custom binary path also refers to that server's filesystem. Follow [remote access setup](/learn/remote/remote-access) when your interface and coding machine differ.

## Check permissions and usage before scaling work

Provider modes differ. Kiro and Muse expose two modes; Pi has no Auto reviewer; Cursor uses SDK sandbox and review controls. Read [permission modes](/learn/safety/permission-modes) alongside the provider guide.

Use [Usage and limits](/learn/customize/usage-and-limits) to distinguish estimated API-equivalent cost from subscription billing. A shared interface does not give every provider the same quota, model catalog, or conversation rewind support.

## Next steps

- Follow the provider guide linked in the comparison table to connect your agent.
- Use the [welcome wizard](/learn/start/welcome-wizard) to check Claude Code and Codex and import supported history.
- Learn how to [work with threads](/learn/threads/working-with-threads) after the provider is ready.
