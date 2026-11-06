---
title: "T3 Code broke me"
description: "Follow Theo's T3 Code walkthrough of multiple providers, remote machines, inbox-style threads, and review workflows, with links to current feature guides."
updated: 2026-11-04
sources:
  - label: "Theo Browne: T3 Code broke me"
    url: "https://www.youtube.com/watch?v=uLGxb4F3SyI"
  - label: "Provider setup (docs/user/install.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Working with threads (docs/user/thread-sidebar.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md"
  - label: "Remote access (docs/user/remote-access.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md"
  - label: "Source control (docs/user/source-control.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md"
  - label: "Portable handoffs (docs/user/portable-handoffs.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md"
  - label: "Messages and voice input (docs/user/composer.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md"
  - label: "Settings and webhook automations (docs/user/project-settings.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md"
  - label: "FAQ and usage caveats (docs/user/faq.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/faq.md"
  - label: "Usage and limits (docs/user/usage.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md"
faq:
  - question: "What is T3 Code broke me about?"
    answer: "Theo walks through T3 Code as a place to manage providers, remote machines, parallel tasks, and code review. The video explains his workflow rather than prescribing one setup for everyone."
  - question: "Does T3 Code run my agents in its own cloud?"
    answer: "T3 Code runs agents on the computer or server you supply. Its remote clients let you control that host; the host must remain running and reachable."
  - question: "Does switching providers copy every part of a thread?"
    answer: "No. T3 Code's portable handoff transfers selected conversation context. It does not copy the previous provider's reasoning, tool-call state, or attachments."
video:
  id: "uLGxb4F3SyI"
  title: "T3 Code broke me"
  durationSeconds: 2510
  chapters:
    - time: "0:00"
      label: "From an alternative app to a different workflow"
    - time: "5:00"
      label: "Providers and cross-provider work"
    - time: "10:01"
      label: "Choose where agents run"
    - time: "16:00"
      label: "Treat the sidebar as an inbox"
    - time: "18:00"
      label: "Steering, queues, and working threads"
    - time: "22:00"
      label: "Terminals, visual replies, and pull requests"
    - time: "25:00"
      label: "Web access, stashes, and remote previews"
    - time: "27:00"
      label: "Switch providers within a conversation"
    - time: "30:00"
      label: "Code hosts, monitoring, and webhooks"
    - time: "32:00"
      label: "Updates, remote editors, and project transfers"
    - time: "36:00"
      label: "Limitations and usage expectations"
    - time: "40:00"
      label: "Stable and nightly builds"
---

T3 Code brings provider choice, remote execution, and task management into one interface in this walkthrough. Theo shows how those pieces change his daily development workflow, from starting work to reviewing and settling it. For users, the video is a broad tour of decisions the app can organize, with current feature guides supplying the setup details.

## What Theo covers: why a shared interface becomes useful

At 0:00, Theo describes the project as an attempt to improve an interface he depends on. He is candid that the early version does not meet his expectations. The story then shifts toward features that make the app useful to him on its own terms.

At 5:00, he shows multiple providers in the same app. The important benefit is a consistent place to start and follow work while using existing provider access. His demonstration includes asking several models to inspect a codebase, then starting similar work in another project.

The argument is about coordination. A second model's opinion is more useful when you can find it, inspect its work, and return to the original task. That does not make every model interchangeable. The provider still supplies the runtime that performs its work.

Theo also shows threads referencing and communicating with other threads. This lets him organize work around projects and tasks instead of treating each terminal session as an isolated island. It requires an explicit request and relevant access, rather than assuming every agent should control everything else.

## What Theo covers: run work where the resources are

At 10:01, the focus moves from provider selection to machine selection. Theo describes choosing a host for a new thread and controlling it through the same interface. His examples include Linux machines, Macs, and remote servers.

At 12:00, he discusses resource-based placement and using machines for their particular capabilities. The developer-facing point is that the computer you type on does not need to perform every build or run every agent. The host still needs the repository, provider access, and tools required by the task.

T3 Connect appears as a way to reach those machines without managing a VPN for every connection. Theo then extends the example to mobile use. His phone becomes another control surface for work already running elsewhere.

This part is useful even if you own only two computers. Before adding more parallel tasks, ask whether your current host is the bottleneck. Remote execution can separate your interactive device from the machine performing long-running work.

## What Theo covers: make the sidebar an inbox

At 14:01, Theo asks what a busy developer should look at next. A list of every conversation does not answer that question. His proposed answer becomes explicit at 16:00: opening a thread should move it toward a state where it no longer needs your attention.

He demonstrates settling completed work and snoozing tasks that should return later. These are different decisions. Completion removes an item from active work; snoozing says it remains relevant at a later time.

At 18:00, he shows steering a running agent, queuing a follow-up, and folding working threads away from the active list. The common aim is to reduce attention spent checking work that has nothing new to report.

At 20:01, pull request links connect the conversation to the result it produces. Once the change merges, the thread can leave the active list. This gives the conversation a visible endpoint instead of making you remember whether an old task still matters.

## What Theo covers: inspect outputs without losing the thread

From 22:00, the tour moves through remote terminals, interactive HTML replies, pull request review, and usage visibility. These demonstrations broaden the definition of an agent's output. A result can be a diff, a chart, a preview, or a file that you inspect directly.

At 25:00, Theo shows the web client, saved prompts, and remote device previews. At 27:00, he switches providers while continuing a task. This is especially relevant when one provider's approach is useful for implementation and another perspective is useful for review.

Later sections cover settings, code hosts, pull request monitoring, webhooks, updates, and troubleshooting. Theo's list is extensive, but its organizing idea stays consistent: keep the work, its evidence, and its next action close together.

The final limitations matter as much as the demonstrations. You supply the computer doing the work. More concurrent tasks can consume more provider allowance. His personal performance and productivity impressions should be read as experience with his setup, rather than guarantees for every machine.

## What it means for you in T3 Code

Start with [provider setup](/learn/providers) and the [GUI versus terminal explanation](/learn/concepts/gui-vs-terminal). Connect the provider on the environment where it runs. An authenticated CLI on your laptop does not authenticate an unrelated remote host.

Use [remote access](/learn/remote/remote-access) for the current connection behavior. The video describes the three-machine T3 Connect limit and a future expansion. The feature page has the current behavior, including higher host limits through linked paid T3 Chat plans. Phones and browsers do not consume host slots.

Use [working with threads](/learn/threads/working-with-threads) to configure settlement, snoozing, and the Working section. The video presents Working as optional beta behavior. Current documentation says it is on by default and each device keeps its preference. A pinned thread stays visible there, but pinning does not prevent automatic settlement.

Use [portable handoffs](/learn/threads/portable-handoffs) before relying on a provider switch for a long task. The current behavior transfers a budgeted selection of history. It does not transfer hidden reasoning, native tool-call state, or attachments. Repeat a critical constraint in your next request when it must remain explicit.

For outputs, follow [visual replies](/learn/workspace/visual-replies), [messages and context](/learn/threads/messages-and-context), and [source control](/learn/workspace/source-control). A useful first experiment is one bounded change followed by a diff review. Add remote hosts and automation after that path works.

The video says provider usage burns at the same rate as direct use. The repository FAQ currently records a Claude Agent SDK issue affecting the five-hour allowance. Use [usage and limits](/learn/customize/usage-and-limits) for the current behavior rather than treating the video's statement as a billing guarantee.

## Next steps

Compare this walkthrough with [the alpha launch](/learn/videos/its-finally-here) to see which problems motivate the project. Return to the [Theo video collection](/learn/videos) for a focused discussion of the workflow you want to change first.
