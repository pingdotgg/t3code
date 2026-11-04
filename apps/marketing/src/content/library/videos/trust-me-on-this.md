---
title: "I need you guys to trust me on this (sorry Anthropic)"
description: "Read Theo's explanation of Claude Code subscriptions in T3 Code, separate the historical policy discussion from setup, and find current provider guidance."
updated: 2026-11-04
sources:
  - label: "Theo Browne: I need you guys to trust me on this (sorry Anthropic)"
    url: "https://www.youtube.com/watch?v=RIkSlHgQYog"
  - label: "Claude setup (docs/user/providers-claude.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md"
  - label: "Provider installation (docs/user/install.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "FAQ: subscriptions and harnesses (docs/user/faq.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/faq.md"
  - label: "Portable handoffs (docs/user/portable-handoffs.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md"
  - label: "Usage and limits (docs/user/usage.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md"
faq:
  - question: "Can I use my Claude Code subscription in T3 Code?"
    answer: "Yes. T3 Code uses Claude Code's login and configuration. Follow the current Claude setup guide on the machine where your agent runs."
  - question: "Does Theo guarantee that Anthropic will never restrict an account?"
    answer: "No. In the video, Theo describes his understanding of the integration and explicitly says he cannot control Anthropic's account decisions. T3 Code does not replace the provider's terms."
  - question: "Am I permanently locked to Claude after starting a T3 Code thread?"
    answer: "The video describes that limitation at the time. T3 Code now supports portable handoffs, which transfer selected conversation context when changing providers."
video:
  id: "RIkSlHgQYog"
  title: "I need you guys to trust me on this (sorry Anthropic)"
  durationSeconds: 1030
  chapters:
    - time: "0:00"
      label: "Claude Code subscriptions arrive in T3 Code"
    - time: "3:00"
      label: "Separate confidence from a guarantee"
    - time: "4:00"
      label: "Why the harness distinction matters"
    - time: "6:00"
      label: "Use the existing local Claude Code setup"
    - time: "8:02"
      label: "Unanswered integration questions"
    - time: "12:01"
      label: "Why T3 Code integrates existing runtimes"
    - time: "14:00"
      label: "Policy uncertainty and historical limitations"
    - time: "15:00"
      label: "Theo's multi-model workflow"
    - time: "16:00"
      label: "An open source interface for existing access"
---

T3 Code adds Claude Code subscription support in this announcement, and Theo explains why its integration uses Claude Code's existing runtime and login. He also discusses uncertainty around provider policy and the limits of his own assurances. For users, the video explains the integration's motivation; the current provider guide supplies the setup and behavior to use today.

## What Theo covers: use Claude Code through another interface

At 0:00, Theo announces that users with Claude Code already installed can use it through T3 Code. The distinction is between the interface organizing the work and the provider access performing it. The announcement does not introduce a T3 Code inference subscription.

He anticipates questions because other integration approaches have faced restrictions. Rather than treat every third-party coding app as equivalent, he asks viewers to examine what runtime and authentication path each one uses.

That is the useful technical question for a T3 Code user. Installing an app that organizes conversations is different from purchasing new model access. If your provider is not installed or authenticated on the machine running the agent, the app cannot replace that missing setup.

The launch is also a step beyond the earlier Codex-only alpha. Theo wants a consistent interface across the providers he uses, while keeping their underlying agent behavior. The rest of the video explains why that goal shapes the integration.

## What Theo covers: confidence is not a policy guarantee

At 3:00, Theo states that he cannot control Anthropic's decisions about accounts. He presents his understanding of the integration, rather than claiming authority over another company's terms or enforcement.

At 4:00, he examines policy language and compares integration designs. His argument is that T3 Code operates through the provider's agent runtime, rather than constructing a replacement runtime and trying to reuse subscription credentials in it.

This section is a historical account of his reasoning. It should not be read as a current legal interpretation, a guarantee against restrictions, or provider endorsement. The exact policy discussion belongs to the time of recording.

For someone deciding how to configure T3 Code, the practical conclusion is to use the documented provider path. A video explaining a past dispute is not a substitute for current setup instructions or the terms attached to your account.

## What Theo covers: keep authentication and execution with the provider

At 6:00, Theo describes the integration as accessing the local Claude Code setup through the Agent SDK. In that version, users authenticate outside T3 Code before using the provider in the app.

He contrasts that design with approaches that manage subscription tokens for a different harness. The important product boundary is where the agent runs and who supplies its access. T3 Code provides the interface, while Claude Code provides the runtime used for Claude tasks.

The video also discusses the economics of subscriptions and API usage. Those figures explain Theo's incentives at the time. They should not be used as a current promise of a fixed amount of inference or a conversion rate between a subscription and API spend.

Users should distinguish a working login from remaining allowance. A connection can be set up correctly and still reach a provider limit. Resolving the login and understanding the limit are different tasks, with different evidence.

## What Theo covers: why developers ask for clearer rules

From 8:02, Theo reviews questions from developers about local development, distribution, hosting, and other integration scenarios. His frustration comes from difficulty mapping broad policy statements to specific applications.

The sequence explains why he spends so much time on architecture. If an app uses an existing agent runtime, the team wants users to understand that path. The implementation choice is part of the product explanation, rather than a promise that future provider rules cannot change.

At 12:01, he returns to T3 Code's design. Supporting different providers requires translating different event and communication formats. He accepts that work because he wants the app to use those existing runtimes.

This is also why a consistent interface does not imply identical provider behavior. Different runtimes may expose different commands, permissions, and session capabilities. The app can organize them without erasing every difference.

## What Theo covers: provider boundaries shape the workflow

At 14:00 and 15:00, Theo discusses the limitations he sees in the recorded version. One is the inability to switch an existing thread to another harness. His workaround is to start a new thread when another provider better suits the next task.

He describes using different model families for different kinds of work. That is his personal preference at the time, rather than a rule that one family must perform all implementation and another all UI work.

At 16:00, the closing argument returns to open source ownership. Theo wants the interface around his work to be available for inspection and modification. That goal is separate from the subscriptions or accounts required to run the agents.

The most useful way to apply this section is to identify which constraint remains current. Some limitations motivate features that arrive later. A historical explanation can remain valuable even after its workaround is no longer necessary.

## What it means for you in T3 Code

Use [Claude Code setup](/learn/providers/claude-code) and [using your Claude subscription](/learn/concepts/use-your-claude-subscription) for the current setup. T3 Code uses Claude Code's login and configuration. Install and authenticate the provider on the environment's machine, including when you control it from a phone.

For the basic path, get [T3 Code](/download), install Claude Code on the host, run `claude auth login`, then enable the provider in `Settings → Providers`. Check the selected environment before diagnosing a missing login. These are separate setup steps even when you perform them on one computer.

The video says provider switching is unavailable. [Portable handoffs](/learn/threads/portable-handoffs) has the current behavior: T3 Code can transfer selected conversation context to another provider. The handoff does not copy hidden reasoning, tool-call state, or attachments, so check what the next task needs before continuing.

The video also says the app has no place for API configuration. The current [Claude provider guide](/learn/providers/claude-code) documents separate configurations and endpoint variables. Use that guide for today's supported choices rather than reproducing the older interface description.

Use [usage and limits](/learn/customize/usage-and-limits) to distinguish reported quotas from estimated API-equivalent cost. T3 Code's estimates are not your subscription bill. The repository FAQ also records a Claude Agent SDK issue affecting the five-hour allowance, so historical statements about identical consumption need that context.

## Next steps

Read [If you have a Claude sub, watch this](/learn/videos/if-you-have-a-claude-sub) for a later discussion of harness choices and usage. Return to [Theo on T3 Code](/learn/videos) for the launch and broader workflow videos.
