---
title: "My last video about AI harnesses"
description: "Understand Theo's distinction between models, harnesses, tools, and T3 Code, then connect the argument to provider setup, skills, and portable handoffs."
updated: 2026-11-04
sources:
  - label: "Theo Browne: My last video about ai harnesses"
    url: "https://www.youtube.com/watch?v=ebILGCoN4UU"
  - label: "FAQ: what is a harness? (docs/user/faq.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/faq.md"
  - label: "Provider setup (docs/user/install.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Commands and skills (docs/user/composer.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md"
  - label: "Claude skills and configuration (docs/user/providers-claude.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md"
  - label: "Portable handoffs (docs/user/portable-handoffs.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md"
  - label: "Outside agents (docs/user/outside-agents.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md"
faq:
  - question: "Is T3 Code an AI harness?"
    answer: "T3 Code uses provider harnesses rather than replacing them. It supplies the interface and coordination around agents that read files, run commands, and edit code."
  - question: "Why are my Claude skills missing after switching to Codex?"
    answer: "T3 Code's shared interface does not make provider configuration identical. Install and enable skills for the provider and environment you select."
  - question: "What does Theo mean by an ADE?"
    answer: "Theo calls T3 Code an agentic development environment. The term describes a place to direct and inspect agent work, rather than an editor centered on typing code."
video:
  id: "ebILGCoN4UU"
  title: "My last video about ai harnesses"
  durationSeconds: 2970
  chapters:
    - time: "0:00"
      label: "Why another discussion of harnesses"
    - time: "3:00"
      label: "Which engineering details deserve attention"
    - time: "10:02"
      label: "A model produces text"
    - time: "11:01"
      label: "Kitchens, tools, and interfaces"
    - time: "15:01"
      label: "Claude Code and its harness"
    - time: "17:02"
      label: "Where T3 Code fits"
    - time: "20:01"
      label: "MCP and coordination outside a harness"
    - time: "24:00"
      label: "Learning to leave a familiar layer"
    - time: "29:01"
      label: "Skateboarding and relearning"
    - time: "40:00"
      label: "Why provider differences still confuse users"
    - time: "46:01"
      label: "An agentic development environment"
---

T3 Code is the example Theo uses to separate an agent's model, its harness, and the interface you operate. The video explains what each layer does and argues that developers should spend less time defending a particular harness. For T3 Code users, that distinction explains both the convenience of a shared interface and the provider differences that remain underneath.

## What Theo covers: abstractions change what deserves your attention

After the introduction, at 3:00, Theo builds a hierarchy of engineering concerns. Formatting choices sit below product decisions. His argument is that some details demand less attention once reliable abstractions handle them.

He traces that pattern through programming languages, formatting tools, code completion, and agents. A developer still benefits from understanding the lower layer, but need not spend every working day operating it directly. In his account, the useful question is where attention produces a better product now.

That framing explains the title. Theo is not arguing that software no longer needs harnesses. He wants developers to stop treating a harness preference as the central identity of their workflow. The distinction between a necessary component and a productive focus is the foundation of the rest of the video.

For a reader choosing an agent app, this suggests a concrete evaluation. Ask whether you can complete and verify your task with the system. A preference for one runtime is less helpful when it prevents you from trying another that suits a particular job.

## What Theo covers: a model needs a harness to take action

At 10:02, Theo describes a language model as a system that produces text. To make that text cause actions, another system must interpret tool requests, execute them, and return results.

His kitchen analogy begins at 11:01. A capable chef cannot prepare a meal in an empty room. Likewise, a model needs tools for operations such as reading a file or running a command. A harness supplies the working environment that makes those operations possible.

At 15:01, he applies the distinction to Claude Code. A product can bundle a human interface with a harness, which makes its name ambiguous in ordinary conversation. The interface you see and the runtime performing the work are related components, but they are not the same responsibility.

This distinction helps diagnose failures. If an agent lacks a tool or permission, a different chat layout will not create that capability. If the problem is locating a task or reviewing its output, a different interface may help without replacing the agent's runtime.

## What Theo covers: T3 Code coordinates existing agents

At 17:02, Theo places T3 Code on the interface side of the diagram. It uses existing provider harnesses. It can add capabilities around them without replacing the loop that makes each agent work.

At 20:01, he describes a separate coordination layer through MCP. The useful point is where the responsibility lives: T3 Code can expose operations that let an agent work with threads and other agents. The provider does not have to contain every one of those operations itself.

At 22:02 and 23:00, he connects that design to cross-provider work. An agent can request another task through T3 Code, which coordinates the interaction. The originating harness does not become the other harness. Each continues to perform its own work while the app connects them.

Treat this as a model for understanding the product, rather than a universal claim about every possible MCP integration. The practical benefit is a shared place to coordinate agents. It does not imply that every provider supports the same commands, skills, or continuation behavior.

## What Theo covers: learning another workflow can be valuable

From 24:00, the video returns to the broader argument about engineering habits. Theo describes how developers often become attached to the layer that is most interesting when they enter the field.

The skateboarding discussion at 29:01 gives that idea a physical example. Learning a trick in the opposite stance requires relearning something familiar. Previous expertise does not eliminate the discomfort, but the new capability can still be worth gaining.

The connection to agents is a willingness to change how you work. Theo encourages viewers to evaluate a new abstraction on what it enables. His predictions about the future of editors and harnesses are opinions, rather than T3 Code requirements.

For users, the measured takeaway is to keep an experiment bounded. Try another provider on a task you can evaluate. Compare the output and effort required. You do not need to replace an entire working setup to learn whether another route is useful.

## What Theo covers: an invisible harness still has differences

At 40:00, Theo describes users who switch providers in T3 Code and expect all their skills to follow. The interface is consistent enough that the boundary becomes hard to see. Provider configuration has not disappeared merely because the controls look familiar.

The final sections describe T3 Code as an agentic development environment. At 46:01, Theo connects that phrase to managing agents, machines, and results. His emphasis is on the environment used to direct development rather than the editor used to type each line.

That ending also puts a limit on the argument. A shared interface can reduce friction, but its users still benefit from knowing where execution and configuration belong. Understanding the boundary lets you spend less time thinking about it during ordinary work.

## What it means for you in T3 Code

Start with [what a harness is](/learn/concepts/what-is-a-harness) and [T3 Code as a control plane](/learn/concepts/control-plane-for-coding-agents). These explain the layers without requiring the video's longer analogies.

Use [Claude Code setup](/learn/providers/claude-code) for Claude-specific configuration and [messages and context](/learn/threads/messages-and-context) for composer behavior. The feature pages have the current behavior. A skill missing after a provider switch is a reason to check the selected provider and environment, rather than assume the model has forgotten it.

Use [portable handoffs](/learn/threads/portable-handoffs) when continuing a task with another provider. T3 Code transfers selected history, not the original runtime's hidden state. Confirm the destination has the tools and instructions required for the next step.

For an agent outside the app, follow [outside-agent access](/learn/safety/outside-agents). Access is a separate setup decision with permissions. The video's coordination examples do not authorize every external client to control your environment automatically.

## Next steps

Read [How I code with AI changed a lot](/learn/videos/how-i-code-with-ai-changed) for the workflow that makes these distinctions useful. Browse [Theo on T3 Code](/learn/videos) for the launch and the later product tour.
