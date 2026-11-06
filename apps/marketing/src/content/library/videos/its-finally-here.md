---
title: "It's finally here: the T3 Code alpha launch"
description: "See why Theo launches T3 Code, how its alpha introduces parallel threads and worktrees, and which current guides replace the early setup instructions."
updated: 2026-11-04
sources:
  - label: "Theo Browne: It's finally here."
    url: "https://www.youtube.com/watch?v=hDn8-fK3XaU"
  - label: "Install T3 Code (docs/user/install.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Working with threads (docs/user/thread-sidebar.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md"
  - label: "Source control (docs/user/source-control.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md"
  - label: "FAQ: harnesses, cost, and remote access (docs/user/faq.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/faq.md"
  - label: "Remote access (docs/user/remote-access.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md"
  - label: "MIT license (LICENSE)"
    url: "https://github.com/pingdotgg/t3code/blob/main/LICENSE"
faq:
  - question: "What does Theo announce in It's finally here?"
    answer: "Theo announces the T3 Code alpha, an open source interface for running coding agents with parallel threads and Git worktrees. The video explains why he and Julius build it."
  - question: "Does T3 Code still support only Codex?"
    answer: "No. That restriction describes the alpha in this video. T3 Code's current provider setup covers Claude Code, Codex, Cursor, and other supported agents."
  - question: "Do I need T3 Chat to use T3 Code?"
    answer: "No. T3 Code is a separate, free, MIT-licensed project. You supply the provider access needed by the agents you run."
video:
  id: "hDn8-fK3XaU"
  title: "It's finally here."
  durationSeconds: 758
  chapters:
    - time: "0:00"
      label: "Why the Codex app changes Theo's workflow"
    - time: "1:01"
      label: "Announcing the open source alpha"
    - time: "3:00"
      label: "Worktrees and the web app demo"
    - time: "4:01"
      label: "Use existing agent harnesses"
    - time: "5:01"
      label: "From a UI change to a pull request"
    - time: "7:00"
      label: "Give the terminal its own job"
    - time: "8:00"
      label: "Early feedback and community ownership"
    - time: "11:01"
      label: "Platform packaging and public history"
    - time: "12:01"
      label: "T3 Code and T3 Chat are separate"
---

T3 Code launches in this video as an open source app for managing coding agents through parallel threads and Git worktrees. Theo explains why the Codex app changes how he builds software, then shows the workflow he and Julius want to improve. Watch it for the project's original purpose, and use the linked feature guides for current setup and behavior.

## What Theo covers: why build another app for coding agents?

At 0:00, Theo starts with a change in his own development habits. Instead of making an editor contain every interaction, he uses an agent app to manage projects and conversations. The editor becomes a place to inspect and change code. Multiple conversations let him move between tasks without making one conversation carry everything.

The problem appears when that workflow becomes central to his day. He describes performance frustrations, worktree limitations, and dependence on one model family. Those are his reasons for starting T3 Code. They explain the product's goals; they are not a benchmark of today's alternatives.

At 1:01, the announcement connects those frustrations to ownership. Theo wants access to the software that organizes his work so he can change it. An open source interface also gives other developers that option. The alpha is a starting point for this experiment rather than a claim that every planned capability already exists.

For a new user, the useful distinction is between choosing a model and choosing where to organize work. You can like an agent's coding behavior while wanting a different interface around it. The launch frames those as separate decisions.

## What Theo covers: separate tasks with threads and worktrees

At 3:00, Theo asks the agent to reduce the blue focus highlight around an input. The request is small enough to follow from prompt to result. While the agent works, he demonstrates the package-based web interface as another way to try T3 Code.

At 5:01, the same example moves into a pull request workflow. The app generates the surrounding Git text and performs the requested Git actions. The demonstration makes the intended unit of work clear: a task becomes a change you can review and ship, rather than an answer that remains in chat.

The next part shows another task starting while the first remains available. Worktrees give each task a separate working directory and branch. That separation matters when both agents edit files. Separate conversations alone would not prevent them from changing the same checkout.

Theo also opens a terminal associated with the worktree. His point is practical: an agent app can handle task organization without removing access to ordinary development tools. You can still inspect the workspace or run a command yourself when that is the useful next action.

## What Theo covers: keep the provider's harness

At 4:01, Theo explains the architectural choice behind the interface. The alpha uses Codex's CLI and app server. It does not introduce a replacement agent runtime for making code changes. Other provider integrations are plans at this point in the video.

At 5:01 and 6:01, he expands the distinction. A harness gives a model tools and runs its work. T3 Code supplies an interface around that capability. His argument is that provider harnesses receive ongoing work that he wants users to keep benefiting from.

This is why the video discusses existing subscriptions. T3 Code does not sell the inference used in the demonstration. Users bring provider access. The same distinction remains useful when troubleshooting: a missing provider login and a problem opening the app belong to different setup steps.

The alpha's provider list is historical. Read the current [T3 Code overview](/learn/start/what-is-t3-code) and [Codex setup](/learn/providers/codex) for today's connection options. Those feature pages have the current behavior, including options that did not exist when Theo recorded the launch.

## What Theo covers: an open project with a public development history

At 7:00, Theo describes the interface problems that push him away from terminal-based agent conversations. Thread switching, images, selection, and scrolling are his examples. He also says the new workflow leads him to use the terminal more for its original jobs.

At 8:00, he asks for detailed feedback while explaining the early contribution restrictions. Treat those restrictions as launch context. They describe the team's capacity during the alpha, rather than a permanent rule for the project.

The closing sections discuss platform support, the decision to preserve Git history, and the separation from T3 Chat. Public history lets readers examine how the app develops. It does not make every early design a recommendation to copy into another project.

At 12:01, Theo describes possible future business ideas without presenting them as available products. The concrete takeaway is narrower: the announced app is a separate open source project that uses access you supply.

## What it means for you in T3 Code

Start with [the official download](/download), then follow [Install T3 Code on macOS](/learn/start/install-macos) if that is your platform. The installation guide has the current behavior. In particular, use its current commands rather than copying the alpha package tag shown in the video.

Use [threads](/learn/threads/working-with-threads) to separate tasks. Choose a new worktree when a task needs its own branch and working directory. Before launching several edits, decide which task owns which change. A worktree separates files on disk; you still need a plan for combining the results.

Use [source control and pull requests](/learn/workspace/source-control) to inspect the output before merging. Current Git actions can generate commit messages, review titles, and descriptions. Configure authentication on the machine running the T3 Code server, including when you connect remotely.

The video presents remote execution as future work. The [remote access guide](/learn/remote/remote-access) has the current behavior: agents run on the host you connect to, and that host must remain running and reachable. This changes where the work happens without changing the task you need to define.

Read [the MIT license explanation](/learn/open-source/mit-license) to understand the app's license separately from provider access. The app's open source status does not turn a provider subscription into a T3 Code subscription.

## Next steps

Read [T3 Code broke me](/learn/videos/t3-code-broke-me) for Theo's later overview of the workflow. Use the [Theo video collection](/learn/videos) to choose a deeper discussion of harnesses, parallel work, or terminal interfaces.
