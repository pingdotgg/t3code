---
title: "You're using AI agents wrong"
description: "See how Theo uses T3 Code to frame tasks, audit pull requests, manage an inbox of threads, and remove friction from testing agent-written changes."
updated: 2026-11-04
sources:
  - label: "Theo Browne: You're using AI agents wrong"
    url: "https://www.youtube.com/watch?v=q1D90-uGvBg"
  - label: "Working with threads (docs/user/thread-sidebar.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md"
  - label: "Source control and PR watching (docs/user/source-control.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md"
  - label: "Remote access (docs/user/remote-access.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md"
  - label: "Commands, skills, and attachments (docs/user/composer.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md"
  - label: "Claude skills (docs/user/providers-claude.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md"
  - label: "Permission modes (docs/user/permission-modes.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md"
  - label: "Updating and release tracks (docs/user/updating.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/updating.md"
faq:
  - question: "What is Theo's main advice for using AI agents?"
    answer: "Use T3 Code to give work a clear outcome, let the agent investigate, and verify the result before shipping. Theo also improves the surrounding workflow when testing or review creates repeated friction."
  - question: "Do I need many parallel agents to use T3 Code well?"
    answer: "No. T3 Code can separate independent tasks, but useful scope and verification matter more than a task count. Start with work you can review before increasing concurrency."
  - question: "How do I stop losing track of T3 Code threads?"
    answer: "Settle completed T3 Code threads, snooze work until it matters again, and link pull requests to the conversations that track them. The thread guide explains the current automatic settlement rules."
video:
  id: "q1D90-uGvBg"
  title: "You're using AI agents wrong"
  durationSeconds: 2962
  chapters:
    - time: "0:00"
      label: "Recover coding time in a busy schedule"
    - time: "4:00"
      label: "Start with a real skills bug"
    - time: "5:00"
      label: "Choose a remote host and worktree"
    - time: "7:00"
      label: "Explain priorities and uncertainty"
    - time: "10:01"
      label: "Let work run without watching it"
    - time: "12:01"
      label: "Audit a pull request before manual testing"
    - time: "16:02"
      label: "Prioritize open pull requests"
    - time: "19:00"
      label: "Ask for an explanation you can use"
    - time: "28:00"
      label: "Link reviews and manage follow-up work"
    - time: "33:01"
      label: "Verify provider behavior instead of assuming"
    - time: "37:01"
      label: "Make remote changes testable"
    - time: "44:00"
      label: "Build a safety net around releases"
---

T3 Code is where Theo demonstrates a development workflow built around clear requests, independent investigations, and practical verification. He works through real bugs and pull requests while explaining how he keeps review and testing from becoming bottlenecks. The useful lesson for users is to improve the path from a task to a trusted result, rather than measure success by how many agents are running.

## What Theo covers: define the outcome before the implementation

At 4:00, Theo starts with a reported problem involving manually invoked skills. He turns the report into a task, selects a remote host, and uses a worktree. The task asks for investigation before implementation.

From 7:00, he explains the prompt sentence by sentence. Some statements describe requirements: the fix should be small and the experience should make sense to users. Others describe a tentative preference about how skill invocation should work.

He makes his uncertainty explicit. The agent should inspect both the provider's behavior and T3 Code's integration instead of treating his theory as established fact. He also gives it a stopping condition: return when it finds a confident, understandable path to a fix.

This is a useful pattern for bug reports. State the behavior you observe, the outcome you want, and what you do not yet understand. A request to inspect a system should say whether implementation is part of the task. Otherwise, the agent may act before you have made the decision you intended to make.

## What Theo covers: separate attention from execution

At 10:01, Theo leaves the running task and works on something else. Watching a conversation does not make its commands finish sooner. His workflow depends on giving the agent enough scope to make progress while he uses the waiting time elsewhere.

At 12:01, he starts another investigation around a contributor's pull request. Manual testing would require changing his authentication setup. He asks the agent to look for clear problems first, reducing the chance of spending that setup effort on a change that is not ready.

The audit covers reliability, API request frequency, and whether displayed information could mislead users. It compares existing implementations and reports concerns. The point is to remove avoidable uncertainty before the human test, rather than assume an audit replaces the test.

Theo's host choice supports this separation. The work can continue on another computer while his laptop handles other tasks. His hardware and operating-system observations describe his own workload. They are not a claim that another user's host can run unlimited agents.

## What Theo covers: make results readable and priorities explicit

At 16:02, Theo asks agents to sort open pull requests by the next action they need. A good output should distinguish work that is ready, work needing another pass, and work that should close.

He also compares answers and rejects one that underestimates the difficulty of a native change. This is a useful correction to a common assumption: a convincing task list is not evidence that its recommendations are right. The person making the decision still needs to check consequential judgments.

At 19:00, an earlier investigation finishes. Theo understands the problems but finds the proposed fix hard to parse. He asks for a clearer explanation before continuing. The agent's communication is part of the work product, so improving it is a valid follow-up task.

He then asks for a draft contributor comment and reviews its content before authorizing publication. That keeps the technical findings useful to both him and the contributor. The communication step has its own intended audience and outcome.

## What Theo covers: close the loop around pull requests

At 28:00, Theo links a pull request to the thread tracking it. This connects a conversation to the change whose eventual merge should resolve the task. Snoozing keeps it out of the active list while another person works on it.

At 29:01, he describes a babysitting skill that checks automated review feedback, evaluates it, applies useful fixes, and checks again. The important word is evaluates. The goal is to resolve real problems, rather than change code merely because a bot produces a comment.

At 33:01, the skills investigation finds a difference between documented behavior and behavior observed through the SDK. Theo asks for further verification and existing issue reports. The lesson is to test the execution path you are integrating, because another path with a similar name may behave differently.

The investigation's intermediate findings are historical. They explain why the work happens in the video. They should not be copied into a current setup guide as though the bug still exists unchanged.

## What Theo covers: remove friction from testing and shipping

From 37:01, Theo demonstrates the infrastructure he builds to test remote changes on his own device. He tries a file attachment and then an image attachment through the changed flow. The tests follow the actual user action he is worried might break.

He then discusses the different needs of web, mobile, and desktop testing. A browser preview does not prove a desktop-only authentication path works. He improves access to preview builds so the relevant test is less costly to perform next time.

At 44:00, the focus moves to release safety nets. A staged audience can expose regressions before broader distribution. Theo's account does not remove the need for tests or review. It describes another layer of evidence around a merge.

The wider pattern is to notice recurring hesitation. If testing a change is too hard, improve the test path. If reviewing a result is too confusing, improve the explanation. Each improvement can make the next task easier to complete responsibly.

## What it means for you in T3 Code

Use [parallel agent workflows](/learn/concepts/run-agents-in-parallel) for independent investigations and [AGENTS.md and skills](/learn/concepts/agents-md-and-skills) for repeatable project guidance. Start with one well-defined task and expand only when you can inspect the results.

Use [Claude Code setup](/learn/providers/claude-code) and [messages and context](/learn/threads/messages-and-context) for current skill behavior. The feature pages have the current behavior. The repository documents `$` skill selection and restrictions on multiple manual-only invocations, rather than the exact broken interaction shown in the video.

Use [threads](/learn/threads/working-with-threads) to settle finished work and snooze pending decisions. Link the relevant pull request, then use [source control](/learn/workspace/source-control) for current review and watch behavior. T3 Code now has built-in pull request watching, so the personal polling skill in the video is not a required setup step.

Use [permission modes](/learn/safety/permission-modes) to control actions independently of your task description. A request to investigate should still state its boundary clearly. Use [remote access](/learn/remote/remote-access) when execution needs to continue on a host separate from your interactive device.

## Next steps

Read [Agents sucked at UI](/learn/videos/agents-sucked-at-ui) for a focused example of repeated reviews and visual evidence. Return to [Theo on T3 Code](/learn/videos) for the collection and other workflow discussions.
