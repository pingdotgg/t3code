---
title: "Ideas behind T3 Code"
description: "Understand why T3 Code separates agents from their interface, how subscriptions connect, and how to organize parallel coding work."
updated: 2026-11-04
sources:
  - label: "Theo explains why T3 Code is not a harness"
    url: "https://www.youtube.com/watch?v=xJaMTo2YgO8&t=300s"
  - label: "Theo explains models, harnesses, and interfaces"
    url: "https://www.youtube.com/watch?v=ebILGCoN4UU&t=602s"
  - label: "Architecture and environment ownership"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md"
  - label: "Provider setup"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
faq:
  - question: "What is the idea behind T3 Code?"
    answer: "T3 Code gives you one interface for directing coding agents while their providers retain their own runtimes and configuration."
  - question: "Is T3 Code an AI model?"
    answer: "T3 Code is a control plane for coding agents. You connect providers such as Claude Code, Codex, or Cursor to do the work."
  - question: "Can I keep my existing agent subscription?"
    answer: "T3 Code supports provider connections using existing accounts. The provider controls eligibility, terms, and usage limits."
---

T3 Code is an open-source control plane for coding agents. It gives you one place to direct work across providers, projects, and environments while the agents keep their own runtimes.

## What does a control plane do?

Start with [the definition of a control plane for coding agents](/learn/concepts/control-plane-for-coding-agents). That page explains the phrase on the homepage: T3 Code organizes and controls agent work, while the selected environment owns execution.

The distinction becomes useful when you troubleshoot. A missing provider login belongs to the environment running the agent. A conversation belongs to a thread. A model choice does not tell you everything about the tools and configuration behind it.

Read [what a harness is](/learn/concepts/what-is-a-harness) to separate the model, its runtime, and the interface you use. Theo explains this distinction through a kitchen analogy in his harness video. His point is practical: changing the interface does not make every provider's skills and plugins interchangeable.

## Should you work in an app or a terminal?

Theo's move toward apps starts with the work he wants to manage: several projects, independent tasks, screenshots, and review. [The app-versus-terminal guide](/learn/concepts/gui-vs-terminal) explains that choice without requiring you to abandon shell commands.

T3 Code includes terminals and source control. You can use the app to follow conversations and inspect changes, then use a terminal for a command you want to run yourself. Choose the surface around the task you need to complete.

## Which account pays for the agent?

Choose the connection that matches the account you already use:

- [Use your Claude subscription](/learn/concepts/use-your-claude-subscription) explains the existing Claude Code login and configuration.
- [Use your ChatGPT plan with Codex](/learn/concepts/use-your-chatgpt-plan) covers connecting ChatGPT or using a Codex CLI login.
- [Compare Claude Code, Codex, and Cursor](/learn/concepts/claude-code-vs-codex-vs-cursor) separates Theo's opinions from documented T3 Code integration behavior.

The provider still controls its plan. Treat videos about prices, quotas, and preferred models as time-bound discussions. Use the provider's current terms and account information for purchasing decisions.

## How do you keep several agents useful?

[Running agents in parallel](/learn/concepts/run-agents-in-parallel) starts with separate tasks and worktrees. Define what each agent owns, decide how to verify its result, and review the combined change.

[AGENTS.md and skills](/learn/concepts/agents-md-and-skills) covers instructions you want repeated and workflows you want loaded for a specific task. Theo recommends shaping these files around observed failures and your project's needs.

## Next steps

[Download T3 Code](/download) when you are ready to connect an agent.

Follow [the introduction to T3 Code](/learn/start/what-is-t3-code) for the product overview, or return to [the full library](/learn) for a task-specific guide.
