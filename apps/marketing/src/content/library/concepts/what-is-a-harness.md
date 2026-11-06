---
title: "Harness, model, and control plane: what each one does"
description: "Separate the model, agent harness, and T3 Code control plane so you know which layer owns tools, configuration, and your coding workflow."
updated: 2026-11-04
sources:
  - label: "Theo explains the tool-calling loop"
    url: "https://www.youtube.com/watch?v=I82j7AzMU80&t=240s"
  - label: "Theo explains models and harnesses"
    url: "https://www.youtube.com/watch?v=ebILGCoN4UU&t=602s"
  - label: "Theo explains provider-specific skills"
    url: "https://www.youtube.com/watch?v=ebILGCoN4UU&t=2400s"
  - label: "Theo distinguishes T3 Code from the harness"
    url: "https://www.youtube.com/watch?v=xJaMTo2YgO8&t=300s"
  - label: "Architecture"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md"
  - label: "Provider glossary"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/glossary.md"
  - label: "Claude skills"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md"
  - label: "Portable handoffs"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md"
faq:
  - question: "Is T3 Code a harness?"
    answer: "T3 Code is a control plane that connects to agent harnesses. Claude Code and Codex supply provider runtimes beneath its interface."
  - question: "What does an AI coding harness do?"
    answer: "A harness provides the tools and runtime that let a model act on a workspace. T3 Code lets you direct agents that use those harnesses."
  - question: "Is a model the same as an agent?"
    answer: "In Theo Browne's explanation, an agent combines a model with a harness that gives it tools and context. T3 Code manages work across those agents."
  - question: "Why are my Claude skills missing in Codex?"
    answer: "T3 Code uses the selected provider's configuration. Installing a skill for Claude Code does not by itself install that skill for Codex."
---

T3 Code is a control plane for coding agents, while a harness supplies the runtime and tools that let a model act. Claude Code and Codex are examples of agent runtimes that T3 Code connects to. Choosing a different interface does not replace those runtimes with one shared harness.

## What is the difference between a model and a harness?

In Theo's explanation, a model generates responses, including requests to use tools. A harness makes those requests actionable. It defines tools, supplies context, executes allowed operations, and returns results so the model can continue.

His kitchen analogy gives you a useful distinction: a capable chef still needs a kitchen and utensils. In the same way, a model needs an execution system to read a repository, edit a file, or run a test.

| Term          | Question it answers                              | Example in a coding task                          |
| ------------- | ------------------------------------------------ | ------------------------------------------------- |
| Model         | What generates the next response?                | The selected model proposes a tool call           |
| Harness       | What can execute that request?                   | The runtime reads a file and returns its contents |
| Agent         | What combines reasoning with the ability to act? | A model working through a harness                 |
| Control plane | Where do you direct and follow that work?        | T3 Code organizes the thread and its activity     |

This is a way to understand responsibilities. A product name can cover several layers. Theo describes Claude Code's terminal interface as an interface bundled with a harness. Calling the whole product a harness is common shorthand, but it can hide which part you mean.

## How does the agent keep working after a tool call?

Theo walks through this in his video about how Claude Code works. A request such as “What files are in this folder?” requires more than a text answer if you want current filesystem evidence.

The basic sequence is:

1. You give the agent a task.
2. The model requests an available tool, such as a command runner.
3. The harness applies the relevant permissions and executes the operation when allowed.
4. The tool result becomes context for the next model response.
5. The agent continues or reports its result.

The execution step uses ordinary software. The model does not gain direct access to your computer merely by producing a command. This is why tools, permissions, and the environment matter alongside model capability.

## Where does T3 Code sit in that sequence?

T3 Code provides the interface and orchestration around provider runtimes. It presents work in threads and controls the selected environment through authenticated requests. The environment owns the provider process, files, Git operations, and terminals.

Read [the control-plane definition](/learn/concepts/control-plane-for-coding-agents) for the canonical explanation. Theo also discusses this separation in [How I code with AI changed a lot](/learn/videos/how-i-code-with-ai-changed) and [My last video about AI harnesses](/learn/videos/my-last-video-about-harnesses).

In that later harness discussion, Theo argues that users should be able to focus more on the work than the runtime underneath it. That is his view of the direction of agent interfaces. It does not mean provider differences have disappeared from T3 Code.

## Why do skills and settings change between providers?

A provider brings its own configuration. T3 Code's Claude integration uses Claude Code's login and configuration, including its documented skill locations. That does not establish the same setup for Codex or another provider.

Theo describes users encountering this exact confusion: they see a common model picker and expect Claude skills to appear when they choose Codex. His explanation is that they changed more than the model. They selected another runtime with a different configuration.

Before troubleshooting the app, identify the selected environment and provider. Then check whether the skill exists in that provider's configuration on that machine. [AGENTS.md and skills](/learn/concepts/agents-md-and-skills) explains how to keep instructions useful without assuming automatic portability.

## What transfers when you switch agents?

T3 Code's portable handoff can carry selected conversation history to another provider. It does not copy the previous provider's reasoning, tool-call state, or attachments. For longer threads, the handoff selects context within a budget.

That boundary helps you plan a switch. Keep the requirement explicit in your next message, and ask the receiving agent to inspect current files. Use [portable handoffs](/learn/threads/portable-handoffs) when you need the detailed rules.

You can now diagnose the right layer: model behavior, harness tools, provider configuration, or the T3 Code workflow. That is more useful than treating every failure as a problem with the model alone.

## Next steps

Return to [Ideas behind T3 Code](/learn/concepts) to choose a workflow topic.

Continue with [AGENTS.md and skills](/learn/concepts/agents-md-and-skills), or [download T3 Code](/download) to connect your existing agent runtime.
