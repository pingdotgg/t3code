---
title: "Permission modes"
description: "Choose a T3 Code permission mode for commands and file edits, set defaults for new threads, and understand provider differences and team limits."
updated: 2026-11-04
sources:
  - label: "Permission modes"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md"
  - label: "Managed policy"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/managed-policy.md"
  - label: "Outside agents"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md"
  - label: "Environment filesystem boundary"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/environment-auth.md"
faq:
  - question: "What permission modes does T3 Code have?"
    answer: "T3 Code offers Supervised, Auto-accept edits, Auto, and Full access. Availability and enforcement depend on the provider."
  - question: "What is the default T3 Code permission mode?"
    answer: "T3 Code initially defaults new threads to Full access. Change the default in Settings → Threads → New threads → Permissions; projects can override the environment default."
  - question: "Why does T3 Code still ask for approval in Full access?"
    answer: "T3 Code providers can retain native checks or configuration that requires approval. Claude and Antigravity have documented cases where requests still appear in Full access."
  - question: "Does changing the default affect existing T3 Code threads?"
    answer: "T3 Code keeps existing threads and modes already chosen in a draft unchanged. New threads use the configured default rather than copying the mode of the thread you were viewing."
---

T3 Code permission modes control when an agent needs approval for commands and file changes. Choose Supervised, Auto-accept edits, Auto, or Full access for a thread, subject to provider support and any managed limit. The initial default for new threads is Full access.

## Which permission mode should I choose?

Choose the mode by the actions you want to review. Requiring more approvals means you remain available to answer them. Removing those prompts means the agent can proceed with the permissions its provider and environment allow.

| Mode              | Approval behavior                                                                            | Use it when                                                       |
| ----------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Supervised        | Requests approval for commands and file changes; some provider read-only actions can proceed | You want to inspect proposed actions as work progresses           |
| Auto-accept edits | Automatically approves edits; other actions can still require approval                       | You accept file changes but want review of other actions          |
| Auto              | Uses provider automatic review for routine actions and asks about others                     | You want the provider's review to handle routine decisions        |
| Full access       | Allows commands and edits without ordinary approval prompts                                  | You intend to let the agent act without waiting for those prompts |

Permission modes govern approval behavior. They do not make a project a filesystem sandbox. T3 Code's environment is the filesystem boundary, and files accessible to its server account can extend beyond a project directory. Read [security and privacy](/learn/safety/security-and-privacy) when selecting a host for sensitive work.

## Change permissions for the current thread

1. Open the message composer in the thread you intend to change.
2. If the thread uses your default mode, open the model picker and choose **Permissions** at the bottom.
3. Select the mode you want for that thread.

You can also open the permission control with `mod+shift+a`. A new thread names its mode under the composer. A thread using another mode shows that mode beside the model. Check the thread itself when moving between tasks with different review requirements.

## Set the default for new threads

Open **Settings → Threads → New threads → Permissions** to set the environment default. Projects can override it. A new thread uses that configured setting, rather than inheriting the mode of whichever thread you last viewed.

Changing the default leaves existing threads unchanged. It also preserves a mode you already chose in a draft. If a thread behaves differently from your current default, inspect its own selection before changing other settings.

Team administrators can impose a [managed permission ceiling](/learn/safety/managed-policy). Modes above the ceiling show who manages them. A default cannot override that ceiling. An existing thread above the cap must move to an allowed mode before another turn can run.

## Why does Auto behave differently across providers?

Auto uses automatic review on Codex, Claude, Cursor, Grok, and fx. Providers without an equivalent, including OpenCode and Antigravity, fall back to asking. Auto therefore does not promise the same number of prompts across agents.

Some providers support fewer modes:

- Muse Code and Kiro offer Supervised and Full access. A Muse thread saved with another mode runs in Supervised.
- fx does not offer Auto-accept edits or Full access. A thread saved in either runs in Supervised.
- Grok does not offer Auto-accept edits. A thread saved in that mode runs in Supervised.
- ACP Registry agents run their tools in their own modes. T3 Code answers approval requests according to the T3 Code permission mode.

Grok file-change approvals can allow all edits for the session. Its command approvals have no session-wide choice because the provider would remember that command across the project. Antigravity offers remembered approvals only for actions that support them.

## Why can Full access still stop or ask?

Claude can still request approval when its settings disable bypass permissions or require approval for a particular action. Its dangerous-removal checks can reject a command even in bypass mode. If the warning provides a safe rewrite, Claude can use it. Otherwise it continues without the removal and explains what it skipped.

Antigravity can still send native requests in Full access. These provider behaviors mean that selecting Full access is not a guarantee that every possible action runs without interruption. A task clarification is also different from an approval request: agents can still ask what you want in any mode.

## Answer requests from agents and subagents

Approve or reject a request in the conversation to let the agent continue. Requests from subagents appear in the parent conversation with the subagent's name. You can respond without switching threads, which matters when [several coding agents run in parallel](/learn/concepts/run-agents-in-parallel).

For a pending Claude approval, a text reply declines that request and sends feedback to the agent that asked. This also works for a subagent. Other pending requests remain unanswered, so review each outstanding decision.

Use the [activity log](/learn/threads/activity-log) alongside the conversation when tracing work. An [outside agent](/learn/safety/outside-agents) has another limit: a thread it starts or steers cannot exceed the permission ceiling granted at MCP sign-in.

## Next steps

Return to [permissions and privacy](/learn/safety) for the full set of controls. Read [managed policy for teams](/learn/safety/managed-policy) before choosing defaults for an organization.
