---
title: "Claude Code, Codex, and Cursor in one app"
description: "Understand Theo's dated comparison of Claude Code, Codex, and Cursor, then connect their current T3 Code integrations without treating it as a ranking."
updated: 2026-11-04
sources:
  - label: "Theo comparison, published May 26, 2026"
    url: "https://www.youtube.com/watch?v=JMYspR42HFM&t=0s"
  - label: "Theo contrasts interface priorities"
    url: "https://www.youtube.com/watch?v=JMYspR42HFM&t=780s"
  - label: "Theo discusses verification and environments"
    url: "https://www.youtube.com/watch?v=JMYspR42HFM&t=1380s"
  - label: "Theo discusses integration choices"
    url: "https://www.youtube.com/watch?v=JMYspR42HFM&t=1860s"
  - label: "Theo closes with workflow recommendations"
    url: "https://www.youtube.com/watch?v=JMYspR42HFM&t=2100s"
  - label: "Claude provider"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md"
  - label: "Codex provider"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-codex.md"
  - label: "Cursor SDK and local runtime"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/cursor.md"
  - label: "Portable handoffs"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md"
  - label: "Source-control review"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md"
  - label: "Cursor local SDK implementation"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/provider-cursor/src/server/adapter.ts"
faq:
  - question: "Which is best in T3 Code: Claude Code, Codex, or Cursor?"
    answer: "T3 Code supports all three. Theo's comparison discusses their philosophies and his workflow preferences rather than establishing a universal ranking."
  - question: "Does T3 Code run the Cursor IDE?"
    answer: "T3 Code's current Cursor V2 integration uses the official Cursor SDK and its local-agent runtime. It runs in the selected workspace rather than embedding the Cursor editor."
  - question: "Can I switch between Claude Code and Codex?"
    answer: "T3 Code supports provider switches through portable handoffs. These transfer selected conversation context and do not copy the previous provider's reasoning, tool-call state, or attachments."
  - question: "Does T3 Code support Cursor cloud agents?"
    answer: "T3 Code's current Cursor guide says its adapter uses the local runtime. Cursor cloud-agent repository and environment configuration is not exposed by that integration."
---

T3 Code lets you use Claude Code, Codex, and Cursor from one interface while each retains its own runtime and configuration. Theo Browne's May 26, 2026 comparison examines the philosophies behind those products and his experience using them. His judgments are a dated perspective, so use the current provider guides for T3 Code setup.

## What does Theo compare in the video?

Theo opens _Claude Code vs Codex vs Cursor (an honest comparison)_ by saying he wants to explain philosophical differences. He distinguishes that goal from comparing intelligence or listing tasks each model can complete.

The useful questions in his discussion concern workflow: how an interface feels, how work gets verified, where code runs, and how a product lets other software integrate with it. Those questions can help you evaluate a provider even after its models and interface have changed.

This page was checked against repository documentation on November 4, 2026. The video's publication date is May 26, 2026. Keep those dates separate when reading a criticism of a product's behavior or an account of an integration problem.

## How does Theo describe Claude Code?

At 4:00 to 6:00, Theo describes Claude Code's terminal-first adoption path. His interpretation is that it met developers in a surface they already used without requiring them to replace their editor.

At 13:00, he emphasizes the motivating feeling of the interface. He argues that Claude Code's visible activity can make agent work feel engaging, and he credits that experience with helping him adopt agent coding more heavily.

These are Theo's assessments of product direction and his own response to the experience. They do not establish how productive another developer will be. For the current integration, [use Claude Code in T3 Code](/learn/providers/claude-code): it uses Claude Code's login and configuration, including separate config directories when needed.

## How does Theo describe Codex?

At 14:01, Theo contrasts that experience with a quieter Codex interface. He says he prefers its minimal presentation for getting work done. Later, he emphasizes checking whether a change worked in a usable environment.

At 23:00 to 24:00, his argument centers on verification and environment setup. He prefers a workflow where the agent can run the project and assess its changes. Treat that as a criterion you can test on your repository, rather than a guarantee attached to a provider name.

The current [Codex setup guide](/learn/providers/codex) documents a ChatGPT connection and an existing CLI-login path. T3 Code can use either documented route. Account access and available features still depend on the selected connection.

## How does Theo describe Cursor?

At 25:00 and again near the conclusion, Theo praises Cursor's cloud-agent workflow. His recommendation focuses on running and testing applications and making that work available to a team.

That part of his video describes his experience with Cursor's own product. T3 Code's current Cursor integration has a different documented scope: Cursor V2 uses the official `@cursor/sdk` package and its local-agent runtime in the selected workspace.

T3 Code does not expose the repository and cloud-environment configuration needed for Cursor cloud agents. Do not infer that a Cursor cloud capability Theo demonstrates is available through T3 Code's local integration. Read [the Cursor provider guide](/learn/providers/cursor) for authentication and supported behavior.

## What do the current T3 Code integrations use?

| Provider    | Documented T3 Code connection                  | Configuration point to check                         |
| ----------- | ---------------------------------------------- | ---------------------------------------------------- |
| Claude Code | Existing Claude Code login and configuration   | The selected environment and Claude config directory |
| Codex       | ChatGPT connection or existing Codex CLI login | The selected account and Codex home                  |
| Cursor      | Official SDK with a local-agent runtime        | Browser sign-in or `CURSOR_API_KEY` on the instance  |

Cursor browser sign-in requires a paid Cursor plan, and a configured `CURSOR_API_KEY` overrides that sign-in. Its editor and CLI logins are separate. Those details matter more to connection troubleshooting than the video's opinion about Cursor's cloud workflow.

Switching providers in T3 Code can use a portable handoff of conversation context. A handoff does not copy reasoning, tool-call state, or attachments from the outgoing provider. Check the receiving provider's configuration and restate important constraints.

## How should you choose for your own work?

Use Theo's comparison to define a trial you can assess. Pick a bounded task and require evidence of the result. Check whether the agent can run the relevant verification in your environment and whether you can review the change clearly.

Inspect [the source-control comparisons](/learn/workspace/source-control) rather than treating an active-looking conversation as proof of completion. The turn diff and branch comparison answer different review questions.

Theo closes by recommending that developers try the options and let the workflow inform their choice. You can do that without turning his May 2026 preferences into a permanent ranking.

## Next steps

Connect [Claude Code](/learn/providers/claude-code), [Codex](/learn/providers/codex), or [Cursor](/learn/providers/cursor) with the current provider instructions.

Return to [Ideas behind T3 Code](/learn/concepts) for the shared concepts, or [download T3 Code](/download) to begin.
