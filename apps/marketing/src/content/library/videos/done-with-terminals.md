---
title: "I'm done with terminals"
description: "Understand why Theo moves agent work into T3 Code: clearer task switching, image context, remote execution, and an interface he can inspect and change."
updated: 2026-11-04
sources:
  - label: "Theo Browne: I'm done with terminals"
    url: "https://www.youtube.com/watch?v=dLhcLqoff6k"
  - label: "FAQ: product purpose and provider boundaries (docs/user/faq.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/faq.md"
  - label: "Working with threads (docs/user/thread-sidebar.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md"
  - label: "Attachments (docs/user/composer.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md"
  - label: "Remote access (docs/user/remote-access.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md"
  - label: "Terminal history (docs/user/terminal.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/terminal.md"
  - label: "Provider installation (docs/user/install.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "MIT license (LICENSE)"
    url: "https://github.com/pingdotgg/t3code/blob/main/LICENSE"
faq:
  - question: "Does T3 Code remove the need for a terminal?"
    answer: "T3 Code can organize agent tasks without making terminal sessions your task list. It also includes terminal access for commands you still want to run or inspect directly."
  - question: "Why does Theo prefer a GUI for coding agents?"
    answer: "Theo finds task switching, screenshots, readable conversations, and remote control easier in a graphical interface. T3 Code is the open source interface he builds around those needs."
  - question: "Can I close T3 Code while a remote agent works?"
    answer: "You can close the client controlling a different host while that host keeps working. The machine running the T3 Code server must remain running and reachable."
video:
  id: "dLhcLqoff6k"
  title: "I'm done with terminals"
  durationSeconds: 1877
  chapters:
    - time: "0:00"
      label: "A terminal-first developer changes habits"
    - time: "3:00"
      label: "The appeal of an agent manager"
    - time: "6:00"
      label: "Projects, worktrees, and readable conversations"
    - time: "8:01"
      label: "The cost of tracking many terminal sessions"
    - time: "13:01"
      label: "Image context and changing workloads"
    - time: "15:02"
      label: "Remote connections and phone friction"
    - time: "17:00"
      label: "What Theo wants from an agent interface"
    - time: "19:00"
      label: "Why T3 Code uses a different architecture"
    - time: "23:00"
      label: "Control a host from another device"
    - time: "25:01"
      label: "Close the client while remote work continues"
    - time: "27:01"
      label: "Why source access matters"
    - time: "29:01"
      label: "Try a workflow organized around tasks"
---

T3 Code is Theo's answer to the task-management and remote-access problems he encounters while running coding agents in terminals. This video traces his move from terminal sessions to a graphical interface for projects, conversations, images, and worktrees. It helps users decide which parts of their workflow benefit from an app while keeping terminal access available for command-line work.

## What Theo covers: the change starts with managing work

At 0:00, Theo describes his long history with terminals. The change is not a discovery that command lines can run software. It is a realization that he spends a full working period without needing his usual terminal app.

At 3:00, he recalls the appeal of an agent-manager view. Seeing work across projects in one place gives him an alternative to remembering which session or window contains each task. This becomes more important as he works on several projects at once.

At 5:00, he describes the awkward transition period. He prompts in one app, locates the resulting worktree, and returns to a terminal for inspection and execution. The task spans multiple tools, each of which requires him to recover the correct context.

The useful question is therefore about organization. Where can you see the task, its workspace, its result, and the action it needs next? A terminal can remain useful without being responsible for holding that entire model in your head.

## What Theo covers: readable conversations and images reduce friction

At 6:00, Theo describes the appeal of project and thread organization in the Codex app. Separate worktrees let multiple tasks proceed independently. Readable conversation text and direct navigation make the interface easier for him to use.

At 8:01, he compares this with the mental map required by many terminal panes. A set of hotkeys works well until the number and shape of tasks change. A remembered mapping can become another thing to maintain.

At 13:01, he discusses the effort he spends making screenshots work through remote terminal layers. The important capability is getting the right image to the agent and seeing what was sent. He finds an app more direct for that operation.

These are interface observations from his workflow, not claims that every terminal lacks image support. His argument is about the accumulated effort of building and maintaining workarounds. If the workaround becomes a recurring task, he wants to remove the need for it.

## What Theo covers: remote control changes when work can start

At 15:02, Theo describes problems with remote typing and managing terminal-based agents from a phone. A connection that is adequate for a short command may still be unpleasant for a long interactive conversation.

The larger issue is continuity. If his laptop must remain open and online for a task, he postpones work around meetings or travel. Moving execution to another computer lets the task continue while the client comes and goes.

At 17:00, he lists the qualities he wants: images, provider access, remote control, Linux support, mobile use, performance, and a clear way to track many tasks. T3 Code is built around that combination.

His operating-system and hardware comparisons describe machines he uses. They should not be turned into a blanket capacity guarantee. Agent processes, test suites, and builds can have very different CPU and memory demands.

## What Theo covers: T3 Code grows out of those constraints

At 19:00, Theo tells the origin story of building a graphical interface. He experiments with a native app, then uses Electron and a WebSocket-based design. His account explains why remote clients become a central part of the product.

He also describes Julius's preference for graphical workflows. That helps push the app beyond a chat box around a provider. Worktrees, Git actions, and multiple provider integrations reduce the need to reconstruct tasks in separate tools.

At 23:00, the mobile app enters the demonstration. The same remote host can be controlled from a desktop client, web client, or phone. The device you carry becomes a place to inspect and direct work rather than the only place work can execute.

At 25:01, Theo quits the controlling client and returns through another surface while the remote task continues. The host remains the source of execution. This is the behavior that changes how he schedules tasks around the rest of his day.

## What Theo covers: source access keeps the interface changeable

At 27:01, Theo connects the interface choice to open source software. He wants developers to be able to inspect and change the environment they use for building. An interface that becomes central to daily work should not be beyond its users' reach.

This point is separate from the provider subscription discussion. Owning access to an app's source does not mean owning the models or the terms of an external service. T3 Code's role is to use those providers through its own interface.

At 29:01, he asks viewers to try a graphical workflow before assuming the terminal is the best fit. The ending is a challenge to evaluate a habit through experience. It does not require abandoning the command line for jobs it already handles well.

For a user, a small test is enough to begin. Take one task that normally needs a screenshot, a separate checkout, and a later review. See whether keeping those steps together reduces the effort needed to finish it.

## What it means for you in T3 Code

Read [GUI versus terminal](/learn/concepts/gui-vs-terminal) for the decision behind the video. Use [threads](/learn/threads/working-with-threads) to separate tasks and select a new worktree when code changes need an independent branch and directory.

Use [messages and context](/learn/threads/messages-and-context) to attach images and other evidence. Give the screenshot a task: identify the error, compare two states, or verify a specific visual change. An image without a clear question leaves the agent to guess what matters.

Use [terminal history](/learn/workspace/terminal) when you need to run or inspect commands directly. T3 Code retains terminal output on the environment server within documented limits. Moving task organization into the app does not remove that command-line path.

Use [remote access](/learn/remote/remote-access) and [mobile access](/learn/remote/mobile-apps) for current setup. The video says macOS background support is coming later. The feature page has the current behavior: `t3 up` can configure a background service on macOS and Linux. Windows uses a different hosting path.

Closing a client that controls a remote host is different from closing the desktop app that hosts local work. The current remote guide states that closing the host app's last window stops its local server. Choose the host deliberately before relying on a task to continue.

## Next steps

Read [How I code without typing](/learn/videos/code-without-typing) for the input and navigation constraints behind this change. Return to [Theo on T3 Code](/learn/videos) for the launch and focused workflow discussions.
