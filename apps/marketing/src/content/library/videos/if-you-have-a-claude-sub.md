---
title: "If you have a Claude sub, watch this"
description: "Follow Theo's T3 Code discussion of subscriptions, task scope, remote hosts, and verification, with current guides for provider instances and usage limits."
updated: 2026-11-04
sources:
  - label: "Theo Browne: If you have a Claude sub, watch this"
    url: "https://www.youtube.com/watch?v=D8PikZ1KhUo"
  - label: "Claude configuration (docs/user/providers-claude.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md"
  - label: "Codex configuration (docs/user/providers-codex.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-codex.md"
  - label: "Provider instances (docs/user/install.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Usage and proxy hub reporting (docs/user/usage.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md"
  - label: "Working with threads (docs/user/thread-sidebar.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md"
  - label: "Remote access (docs/user/remote-access.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md"
  - label: "Source control (docs/user/source-control.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md"
  - label: "Messages and context (docs/user/composer.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md"
faq:
  - question: "Do I need multiple Claude accounts to use T3 Code?"
    answer: "No. T3 Code can use one existing Claude Code setup. Theo's proxy and account pool are an advanced personal workflow, not a prerequisite."
  - question: "Are the video's subscription-to-API cost ratios guaranteed?"
    answer: "No. The figures describe Theo's assumptions and experience at the time. T3 Code reports estimated API-equivalent cost separately from provider subscription limits."
  - question: "Does adding a usage hub route T3 Code requests through it?"
    answer: "No. T3 Code's usage hub connection supplies reporting. Provider configuration separately determines where agent requests go."
  - question: "Can T3 Code continue working after I close my laptop?"
    answer: "Yes, when the work runs on a separate host that remains running. Closing the controlling laptop does not stop that host's T3 Code server."
video:
  id: "D8PikZ1KhUo"
  title: "If you have a Claude sub, watch this"
  durationSeconds: 3996
  chapters:
    - time: "0:00"
      label: "An invitation to use agents more broadly"
    - time: "5:00"
      label: "Subscriptions and API-equivalent estimates"
    - time: "11:00"
      label: "Provider settings and account boundaries"
    - time: "15:00"
      label: "Theo's proxy setup"
    - time: "20:01"
      label: "Routing, affinity, and cache observations"
    - time: "23:01"
      label: "Record how machines are configured"
    - time: "29:01"
      label: "Use agents before and after implementation"
    - time: "33:00"
      label: "Start with the problem you discovered"
    - time: "38:02"
      label: "Treat threads as tasks needing attention"
    - time: "43:00"
      label: "Send background work with a complete outcome"
    - time: "50:01"
      label: "Use agents to inspect and prioritize work"
    - time: "59:00"
      label: "Keep execution on a host that stays available"
---

T3 Code is the workspace Theo uses in this long discussion of subscriptions, parallel tasks, and remote execution. He shows an advanced personal setup, then explains how he gives agents more of the investigation and verification around a change. For users, the durable lesson is to define useful work and a clear review point; the video's account, pricing, and policy claims are historical context.

## What Theo covers: distinguish access from useful output

At 0:00, Theo challenges viewers to experiment more actively with agents. His introduction uses the number of running threads as a provocation. It is not a technical requirement for getting value from T3 Code.

At 5:00, he compares subscriptions with API-equivalent inference costs. His figures describe the plans, model choices, assumptions, and exceptional resets he discusses at the time. They should not be read as guaranteed entitlements or a current pricing table.

The operational distinction is still useful. A subscription allowance, a token count, and an estimated API cost are different measures. More activity can increase the displayed cost estimate without generating an equivalent charge on a subscription bill.

This part explains why Theo experiments with long investigations and repeated reviews. His aim is to use access he already has for work that would otherwise remain undone. For another developer, the relevant question is whether the output helps complete a real task.

## What Theo covers: a proxy is part of his own infrastructure

From 11:00, Theo discusses account settings, hosting concerns, and provider restrictions. He gives opinions about what providers may permit and describes his own experience. He also acknowledges uncertainty about account enforcement.

At 15:00, he introduces a proxy that manages several accounts and exposes an endpoint to his agent runtimes. His dashboard includes changes he makes to the upstream project. A reader installing the same proxy should not expect the same UI or routing behavior automatically.

At 20:01, he discusses request routing, session affinity, and cache observations. The underlying concern is keeping a running conversation from losing useful continuity when account routing changes. His exact cache and reset descriptions belong to his setup and the recording.

This page does not turn his residential-IP strategy, account enforcement assumptions, or policy interpretations into T3 Code guidance. They are not necessary to connect one supported provider. Use the current provider configuration for the actual account and host you control.

## What Theo covers: record the environment an agent needs

At 23:01, Theo shows a repository that records his machines, their roles, and their setup. This gives an agent context for adding another host without asking him to repeat each installation detail.

He describes wanting the same basic development tools and provider access on each machine. The useful idea is to make the environment reproducible enough that a task can run where you place it. A remote client does not supply build tools that are missing from the host.

The proxy remains an optional part of that environment. A simple setup can have one provider account on one machine. Adding more hosts is valuable when it resolves a real resource or availability constraint, rather than because the video uses a fleet.

The same principle helps when troubleshooting. First identify where the task executes. Then check the repository, runtime, credentials, and commands on that machine. Inspecting only the phone or laptop displaying the conversation can miss the source of the problem.

## What Theo covers: expand the task around the merge

At 29:01, Theo shifts from access to workflow. He asks how an agent can reduce the attention a problem requires. Much of his described work goes into verification rather than the first implementation.

At 30:01, he separates two sides of shipping a change. Before merge, improve the likelihood that the code works. After merge, make a failure easier to detect and reverse. His argument supports investing in evidence and recovery, rather than assuming a confident agent response is enough.

At 33:00, he recommends involving the agent when the problem first becomes clear. Giving it a presumed solution too early can narrow the investigation incorrectly. A screenshot or observed failure can be a better starting point than an unsupported theory about the implementation.

He also explains when human attention becomes useful again. If the agent fails to solve the problem or exposes uncertainty, that is a reason to examine the difficult part. Delegation helps locate where judgment is needed; it does not eliminate the need for judgment.

## What Theo covers: treat threads as work awaiting a decision

At 38:02, Theo addresses the difficulty of tracking concurrent tasks. His answer is to treat a thread as a task, with states that indicate whether it is working or needs attention.

At 40:02, he demonstrates settling completed work. Later, he snoozes items that matter at a future time. Both actions keep the active list closer to a set of decisions he can make now.

At 43:00, he demonstrates starting another task without leaving the composer. At 46:00, he explains why the original request should include a preview and pull request when those will be necessary for review. Otherwise, the next visit becomes another instruction to prepare the evidence.

His merge examples depend on permissions and completion conditions in his projects. They do not make every future thread authorized to merge. The useful habit is to name the intended endpoint and the evidence that must precede it.

## What Theo covers: inspect existing work and keep execution available

From 50:01, Theo gives exploratory examples: explain another change, prioritize open reviews, or identify unfinished work worth revisiting. These requests use agents to recover context rather than produce another patch immediately.

The examples also show that discarding a task can be a useful outcome. If the result is not worth pursuing, remove it from active attention. An investigation does not need to become an implementation merely because it consumed time.

At 59:00, he returns to remote hosts. A computer that stays available can continue work while the laptop used for prompting is closed. The closing discussion also recognizes that builds and test runs can exhaust resources even when agent conversations themselves are light.

That is a better capacity test than copying a thread count. Check the commands your tasks run, especially compilers and test suites. Increasing concurrency helps only while the host and the review process can handle the resulting work.

## What it means for you in T3 Code

Start with [Claude Code setup](/learn/providers/claude-code) and [using your Claude subscription](/learn/concepts/use-your-claude-subscription). Use the ordinary login path before considering another provider instance. Current Claude configuration supports separate config directories; it does not use Codex's shared-home and shadow-home arrangement.

Read [usage and limits](/learn/customize/usage-and-limits) before interpreting the video's dashboard. The feature page has the current behavior. A connected hub supplies usage information; it does not configure the provider to send requests through that hub.

Use [parallel work](/learn/concepts/run-agents-in-parallel), [threads](/learn/threads/working-with-threads), and [source control](/learn/workspace/source-control) to give tasks reviewable outcomes. Current T3 Code includes a Working section and pull request watching, so you do not need to reproduce every personal workaround in the video.

Use [remote access](/learn/remote/remote-access) for current host setup and T3 Connect limits. The feature page has the current behavior, including host-limit increases through linked paid T3 Chat plans. Keep the execution host running; a remote client is a control surface rather than replacement compute.

## Next steps

Read [I need you guys to trust me on this](/learn/videos/trust-me-on-this) for the earlier Claude integration announcement and [How I code without typing](/learn/videos/code-without-typing) for the related input workflow. Return to [Theo on T3 Code](/learn/videos) for the full collection.
