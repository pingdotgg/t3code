---
title: "Hand work from one agent to another"
description: "Continue a T3 Code conversation from Claude Code to Codex or another provider, with selected history, recoverable context, and clear handoff limits."
updated: 2026-11-04
sources:
  - label: "Context in portable handoffs"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md"
  - label: "Current handoff selection"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/ContextHandoffService.ts"
  - label: "Historical context delivery"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/ContextHandoffDelivery.ts"
  - label: "History selection and budget"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/provider-core/src/server/handoffBudget.ts"
  - label: "Thread references and session restart"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md"
  - label: "Theo on passing context between agents"
    url: "https://www.youtube.com/watch?v=NvVbCqDgfCs&t=2041s"
faq:
  - question: "Can I move a conversation from Claude Code to Codex in T3 Code?"
    answer: "T3 Code transfers selected saved history when you switch a thread from Claude Code to Codex. It does not copy the outgoing agent's reasoning, tool-call state, or attachments."
  - question: "Does T3 Code summarize my conversation during a handoff?"
    answer: "Current T3 Code portable handoffs select intact historical messages within a budget. They preserve the selected text, order, and user or assistant attribution rather than asking an agent to write a summary."
  - question: "Will T3 Code shorten my new prompt to fit a handoff?"
    answer: "T3 Code keeps your new request separate and does not shorten it to fit history. If necessary, it starts a fresh provider conversation with bounded history and sends your request automatically."
  - question: "Can the new agent recover history left out of the handoff?"
    answer: "T3 Code includes references that let the agent retrieve saved messages and activity through its thread-reading tool. Repeat critical constraints in your next message when they must be immediately visible."
---

T3 Code carries selected conversation history when you switch a thread from Claude Code to Codex or another provider. The handoff gives the next agent saved messages and relevant activity, while your new request stays separate and intact.

## Continue from Claude Code to Codex

Use this workflow when work already lives in a T3 Code thread and you want another agent to continue it. The app's saved conversation history provides the handoff material.

1. Read the recent conversation and identify the next result you want.
2. Select the destination provider and model in the thread.
3. Write the next instruction, repeating any older constraint that must guide the work.
4. Reattach important files when the next agent needs their contents.
5. Send the request and review the continuation.

For example, ask Codex to inspect an implementation discussed with Claude Code, verify the reported test result, and stop before a specified external action. That is a suggested instruction, not an automatic handoff rule. State the responsibility you are transferring.

The provider guides cover setting up [Claude Code](/learn/providers/claude-code) and [Codex](/learn/providers/codex). Both must be available through their configured integrations for your chosen continuation.

## Know what transfers

Short conversations can transfer intact. For longer conversations, T3 Code favors the original request, recent requests and answers, and useful activity such as command outcomes. Selected messages retain full text, chronological order, and user or assistant attribution.

Partial work from interrupted or failed turns can be included. A failed turn can still contain information worth preserving, so review what happened rather than assuming failure means the whole turn is irrelevant.

| Material                               | Handoff behavior                                     |
| -------------------------------------- | ---------------------------------------------------- |
| Selected messages                      | Keep their full text and attribution                 |
| Relevant saved activity                | Can provide command outcomes and other task context  |
| New request                            | Stays separate and is never shortened to fit history |
| Outgoing reasoning and tool-call state | Do not transfer                                      |
| Outgoing attachments                   | Do not transfer                                      |
| Omitted history                        | Remains retrievable from the saved thread            |

Codex can receive historical messages directly when the installed version supports that operation. Other providers receive the same selection as attributed conversation context. This does not recreate a provider-native session or its internal state.

## Recover a requirement that was left out

A handoff is a budgeted selection, not an agent-written summary. It includes references to omitted history. The next agent can use T3 Code's thread-reading tool to retrieve messages and activity, including the remainder of a long item.

For a critical requirement, repeat it in the new message. Examples include a compatibility requirement, a file that must remain untouched, or the exact check that defines completion. Avoid replacing the task with a vague request to continue when the next decision is already clear.

If the new answer overlooks an earlier choice, point it to the saved discussion and ask it to read that history before proceeding. The omitted text is still in the thread. A shorter initial handoff does not mean the conversation was deleted.

## Handle context limits during continuation

The handoff must leave room for your current request, attachments, provider context, instructions, tools, and subsequent work. The initial history allowance defaults to 16,000 estimated tokens. That allowance does not guarantee how much history a particular model can accept.

If the target conversation lacks room, T3 Code starts a fresh provider conversation with a bounded history selection and sends your request automatically. You do not need to compact manually for that recovery path.

If even a fresh conversation has too little room for the request and attachments, shorten the request or select a larger-context model. T3 Code does not shorten your request for you. Image costs and hidden provider context can differ from estimates, so a provider may still reject input.

Recovery keeps running background work intact. Let that work finish or stop it before retrying the handoff. Starting recovery does not itself terminate the work you left running.

## Choose a handoff or a thread reference

Use a provider switch when the same task should continue under another agent. Portable handoffs also support portable restarts and forks that the provider cannot resume natively.

Use a thread reference when a different conversation only needs to consult earlier work. In the [composer](/learn/threads/messages-and-context), a same-server thread chip lets the agent read that history on demand. It does not itself change or message the source thread.

Use separate threads and appropriate workspaces when the tasks should run independently. Read [running agents in parallel](/learn/concepts/run-agents-in-parallel) before turning a continuation into concurrent work. Use [working with threads](/learn/threads/working-with-threads) for the project and worktree choices.

After a V1-to-V2 upgrade, the first continuation also starts a fresh provider session with selected history. [Thread migration](/learn/threads/thread-migration) explains why old conversation text can remain visible while old live sessions and checkpoints do not return.

## Next steps

- Prepare files and references with [messages and context](/learn/threads/messages-and-context).
- Check [thread migration](/learn/threads/thread-migration) for older conversations, or return to [threads and messages](/learn/threads) for other continuation options.
