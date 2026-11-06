---
title: "How I code with AI changed a lot"
description: "Explore Theo's T3 Code workflow for clear conversations, fresh task context, remote execution, and review decisions, with current feature links."
updated: 2026-11-04
sources:
  - label: "Claude subscription credits warning at 9:01"
    url: "https://www.youtube.com/watch?v=xJaMTo2YgO8&t=541s"
  - label: "Theo Browne: How I code with AI changed a lot"
    url: "https://www.youtube.com/watch?v=xJaMTo2YgO8"
  - label: "FAQ: product boundaries and usage caveats (docs/user/faq.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/faq.md"
  - label: "Remote access (docs/user/remote-access.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md"
  - label: "Working with threads (docs/user/thread-sidebar.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md"
  - label: "Messages and context (docs/user/composer.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md"
  - label: "Visual replies (docs/user/html-renders.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/html-renders.md"
  - label: "Source control (docs/user/source-control.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md"
  - label: "Claude provider (docs/user/providers-claude.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md"
  - label: "Usage and limits (docs/user/usage.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md"
faq:
  - question: "Does Theo recommend running every task in parallel?"
    answer: "No. In this video, Theo describes completing many tasks sequentially on a solo project. T3 Code supports separate tasks and worktrees, but concurrency should match the work you can manage."
  - question: "Why does Theo start fresh T3 Code threads?"
    answer: "Theo uses a new T3 Code thread when the concern changes so unrelated conversation history does not steer the next task. Reusable project guidance supplies the context that should stay consistent."
  - question: "Where should I check Claude usage limits in T3 Code?"
    answer: "Open Usage → Limits in T3 Code for reported subscription allowances. The Usage page's estimated API-equivalent cost is not your subscription bill."
video:
  id: "xJaMTo2YgO8"
  title: "How I code with AI changed a lot"
  durationSeconds: 2854
  chapters:
    - time: "0:00"
      label: "Why the previous workflow changes"
    - time: "3:01"
      label: "Model choices in a real project"
    - time: "5:00"
      label: "Harnesses and app interfaces"
    - time: "10:00"
      label: "Why remote execution matters"
    - time: "15:00"
      label: "Mobile plans and terminal friction"
    - time: "18:01"
      label: "Give the agent useful reference code"
    - time: "21:00"
      label: "Discuss the goal and read the reply"
    - time: "26:01"
      label: "Steer behavior with project guidance"
    - time: "31:01"
      label: "Sequential tasks and fresh context"
    - time: "37:01"
      label: "Use concrete examples for complex requests"
    - time: "39:01"
      label: "Give agents ways to verify the work"
    - time: "42:00"
      label: "Choose review scope and retire stale work"
---

T3 Code supports the conversation-centered workflow Theo describes after changing how he uses AI on a large solo project. He explains remote execution, short task prompts, project guidance, and when a change needs deeper review. For users, the video offers a useful counterpoint to the idea that productivity requires an elaborate plan or many concurrent agents.

## What Theo covers: choose tools around the work

At 0:00, Theo revisits an earlier workflow video and explains that many of its recommendations no longer fit how he builds. He uses the development of Lakebed as the concrete setting for the new approach.

At 3:01, he discusses the models he prefers at the time. He explicitly expects those preferences to age. The lasting part of this section is the need to evaluate models in the work you perform, rather than treat a recording as a permanent ranking.

At 5:00, he separates harnesses from the apps around them. He explains why he prefers managing tasks in a dedicated interface. The editor remains available for direct edits, but it no longer needs to hold every conversation and task switch.

His comparisons with other products are personal reports from those versions and environments. Read them as the context for his decisions. They do not establish that today's alternatives will reproduce the same failures on your setup.

## What Theo covers: let work continue on another machine

At 10:00, Theo describes wanting to close his laptop without interrupting the work. He wants to reconnect later and see the result. A separate host makes that possible without requiring his interactive computer to remain the center of execution.

The demonstration compares remote interfaces and the friction of managing agent conversations through a terminal. Images are a recurring example. If a useful prompt includes a screenshot, the path for sending that screenshot should not consume more effort than describing the task.

At 15:00, he discusses mobile access and an app still in development. This is a historical point in the product's evolution. It helps explain the direction, but the current mobile setup no longer depends on that announcement.

The practical condition is unchanged: closing a client is different from stopping the host. The machine that holds the repository and runs the agent must keep running. A remote interface cannot complete work on a computer that has shut down.

## What Theo covers: supply context that changes decisions

At 18:01, Theo moves from tooling to communication. One example gives the agent access to another local repository as a reference. That lets it inspect an existing implementation instead of relying on a vague description of what to copy.

At 21:00, he shows the first conversation for his project. The prompt starts with the intended outcome and asks for criticism before proceeding. He wants the agent to understand what he is trying to accomplish, rather than follow an implementation he has already specified in detail.

At 24:01, he stresses reading the response. If an explanation is too long or hard to follow, ask for a different presentation. Skipping it can hide a disagreement that later appears as an unwanted implementation.

At 26:01, he describes project guidance as a way to reduce repeated misunderstandings. His example explains the purpose of the project and how he wants decisions made. A small glossary also distinguishes the people building the system from its users and their agents.

The useful principle is to preserve intent that applies repeatedly. A longer instruction file is not automatically better. A concrete explanation of why the project exists can help an agent make choices that a catalog of stale details would not resolve.

## What Theo covers: keep separate concerns in separate conversations

At 31:01, Theo makes a point that is easy to miss in a video about agents: most of these tasks run sequentially. He finishes one concern and starts another. This reflects a solo project and his own ability to track context.

At 35:00, he explains why he starts new threads. A previous task's history can steer the model toward decisions that no longer apply. A fresh conversation lets it inspect the current code for the current request.

His examples use short prompts because the surrounding project context is already useful. Shortness is the result of shared understanding, rather than a rule that every problem should fit into two sentences. When the agent lacks information, he adds an example or answers its questions.

At 37:01, a domain setup question becomes clearer through a specific desired flow. The example names the action a user would take and the result they should see. That gives the agent something concrete to reason about without prescribing every internal component.

## What Theo covers: match verification to the change

At 39:01, Theo explains that an agent needs ways to verify its work. Tests, commands, and inspection of a running app can provide different kinds of evidence. The question is whether the intended behavior works, rather than whether code was produced.

At 42:00, he describes deciding when a task needs a separate worktree and pull request. More consequential changes benefit from extra review. His solo-project choices are examples of judgment, not a recommendation to bypass a team's review rules.

The closing example examines a stale branch. The agent finds that newer work already covers its useful behavior. The appropriate outcome is to retire redundant work, rather than resolve conflicts merely because an old branch exists.

This connects context management to delivery. A thread is useful while it helps resolve a concern. A branch is useful while its change is worth landing. Keeping either indefinitely can add confusion rather than preserve value.

## What it means for you in T3 Code

Read [the control-plane explanation](/learn/concepts/control-plane-for-coding-agents) and [what a harness does](/learn/concepts/what-is-a-harness) to separate interface choices from provider behavior. Use [remote access](/learn/remote/remote-access) for the current host setup. That feature page has the current behavior, including mobile clients and T3 Connect options added after this recording.

Use [threads](/learn/threads/working-with-threads) to give each task a clear concern. Choose a new worktree when it needs a separate branch and directory. Use [AGENTS.md and skills](/learn/concepts/agents-md-and-skills) for reusable project guidance, and [messages and context](/learn/threads/messages-and-context) for the evidence a particular request needs.

Use [visual replies](/learn/workspace/visual-replies) when a plan or comparison is easier to inspect as a page. Ask for a presentation that helps you make the next decision, rather than one that adds decoration to an unclear answer.

At 9:01, the recording warns that a change to Claude subscription credits could limit T3 Code users. Do not treat those predictions as current setup instructions. [Claude Code setup](/learn/providers/claude-code) and [usage and limits](/learn/customize/usage-and-limits) have the current behavior documented in the repository.

## Next steps

Read [My last video about AI harnesses](/learn/videos/my-last-video-about-harnesses) for the fuller explanation of models, runtimes, and interfaces. Return to [Theo on T3 Code](/learn/videos) to compare this workflow with later examples.
