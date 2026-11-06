---
title: "What a control plane for coding agents is"
description: "Learn what T3 Code means by a control plane for coding agents, what it controls, and where agent execution and credentials belong."
updated: 2026-11-04
sources:
  - label: "Homepage definition"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/marketing/src/pages/index.astro"
  - label: "Theo distinguishes T3 Code from a harness"
    url: "https://www.youtube.com/watch?v=xJaMTo2YgO8&t=362s"
  - label: "Theo describes the interface above harnesses"
    url: "https://www.youtube.com/watch?v=ebILGCoN4UU&t=2761s"
  - label: "Architecture"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md"
  - label: "Glossary"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/glossary.md"
  - label: "Working with threads"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md"
  - label: "Portable handoffs"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md"
faq:
  - question: "What is a control plane for coding agents?"
    answer: "T3 Code uses the phrase for the interface and orchestration layer that directs agent work across providers, projects, threads, and environments."
  - question: "Does T3 Code run its own AI model?"
    answer: "T3 Code connects to provider runtimes such as Claude Code and Codex. Those runtimes handle their model interactions and agent behavior."
  - question: "Where does code run when I use T3 Code remotely?"
    answer: "T3 Code keeps execution on the environment that owns the workspace. A remote client controls that environment without replacing its filesystem or provider credentials."
  - question: "Does switching providers transfer every setting?"
    answer: "T3 Code can transfer selected conversation context through portable handoffs. That does not copy the previous provider's reasoning, tool-call state, or attachments."
---

T3 Code is the open-source control plane for coding agents: an interface and orchestration layer for directing their work. It connects you to provider runtimes, organizes conversations and projects, and keeps execution in the environment that owns the workspace.

## What does T3 Code control?

The homepage uses “control plane” to describe the layer you interact with across agents. You choose a project, an environment, a provider, and a thread. T3 Code presents the conversation and activity, routes your requests, and keeps the work history available after a provider process exits.

This definition builds on Theo's explanation in [How I code with AI changed a lot](/learn/videos/how-i-code-with-ai-changed). At 6:02, he distinguishes T3 Code from the harnesses it manages. In [My last video about AI harnesses](/learn/videos/my-last-video-about-harnesses), he later calls this kind of interface an agentic development environment.

“Control plane” describes its role in your workflow. It gives you controls for work that otherwise lives across separate agent interfaces. The phrase does not mean T3 Code replaces the provider's runtime or makes every provider behave identically.

## Which layer handles each part of a task?

Use these boundaries when deciding where to configure or troubleshoot something:

| Layer                       | What it contributes                            | Example                              |
| --------------------------- | ---------------------------------------------- | ------------------------------------ |
| Model                       | Generates responses and tool requests          | The model selected for a turn        |
| Harness or provider runtime | Runs the agent loop and exposes its tools      | Claude Code or Codex                 |
| Control plane               | Directs and presents work across runtimes      | T3 Code                              |
| Environment                 | Owns the workspace, credentials, and execution | The machine running a T3 Code server |

[The harness guide](/learn/concepts/what-is-a-harness) explains the first three layers in more detail. For the implementation boundaries, read [how T3 Code works](/learn/open-source/architecture).

Consider an ordinary fix. You ask an agent to investigate a failing test. T3 Code carries that request to the selected runtime. The runtime uses its model and tools to inspect files and run commands. T3 Code shows the resulting conversation and activity so you can assess the work.

The distinction helps you ask a useful next question. If the login is missing, check the provider on the execution machine. If you need another task, start another thread. If the answer used the wrong assumptions, clarify the request and review the current files.

## Where do files and credentials live?

The environment owns provider processes, terminals, Git, and project files. Web, desktop, and mobile clients control that environment through authenticated requests. The desktop app can host a server as well as display the client.

A remote connection therefore does not move execution onto the device displaying the conversation. If you connect from a phone to another computer, the selected computer still needs the repository and provider setup. Start with [remote access](/learn/remote/remote-access) when that separation is your goal.

A thread is the durable conversation and work history within a project. A provider session can stop and resume without deleting that thread. That is why [the T3 Code introduction](/learn/start/what-is-t3-code) describes a broader working surface than one running terminal process.

## Does one interface make providers interchangeable?

The interface provides common controls, but provider capabilities still differ. Skills, authentication, available models, and some conversation operations depend on the selected runtime.

When you switch providers, T3 Code can carry conversation context through a portable handoff. Short conversations transfer intact. Longer ones use a bounded selection that favors recent requests and answers, the original request, and relevant activity.

A handoff omits the outgoing provider's reasoning, tool-call state, and attachments. Repeat an important constraint in your next request when the new agent must have it. A shared interface makes switching manageable; it does not establish identical internal state.

## How should you try this workflow?

1. Choose one project and one bounded task.
2. Confirm which environment owns the project.
3. Connect the provider you already use on that environment.
4. Review the agent's activity and resulting changes before starting more work.

This gives you a concrete way to evaluate the control plane. Judge whether you can find the task, understand what happened, and return to its history. Add more providers or environments when they solve a need you have.

## Next steps

[Download T3 Code](/download) and follow [the product introduction](/learn/start/what-is-t3-code) to begin.

Return to [Ideas behind T3 Code](/learn/concepts) for the wider workflow, or study [the architecture](/learn/open-source/architecture) for the server boundary.
