---
title: "Read the activity log"
description: "Inspect T3 Code tool calls, command output, exit codes, and file diffs, and distinguish orchestration requests from confirmed results."
updated: 2026-11-04
sources:
  - label: "Activity log"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/activity-log.md"
  - label: "Inspect agent work"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md"
  - label: "Messages and context"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md"
  - label: "Activity vocabulary"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/glossary.md"
faq:
  - question: "How do I see the commands an agent ran in T3 Code?"
    answer: "On web and desktop, expand a T3 Code tool-call summary, then open an individual call. It exposes command details, tool inputs, status, exit codes, and available output."
  - question: "Does waiting on a thread mean it has finished?"
    answer: "No. T3 Code distinguishes a request to wait from confirmation that the thread finished. An interrupt or cancellation request also does not prove the target stopped."
  - question: "Why does the activity log show only part of command output?"
    answer: "T3 Code shows the most recent part of long command output, and running output updates live. A visible excerpt may therefore omit an earlier part of the result."
  - question: "Can I inspect a changed file from the activity log?"
    answer: "Use Open diff on a T3 Code file-change entry to review its contents. Review the diff alongside command results when you need to assess the agent's work."
---

T3 Code groups consecutive tool calls into expandable activity summaries on web and desktop. Open a group and then a call to inspect commands, inputs, status, exit codes, and output. Use **Open diff** on a file change to review its contents.

## Find the action behind a summary

A conversation contains both messages and activity. Messages carry the user and assistant discussion. Activity includes non-message items such as tool actions, approvals, and failures. When an agent reports a result, the activity provides the place to inspect the work behind it.

1. Find the relevant tool-call summary in the conversation.
2. Expand it to see the individual actions.
3. Open the call that matches the operation you want to check.
4. Read its status and result, including the exit code for a command.
5. Open the associated diff when the action changed a file.

Use this sequence when a reply says tests passed, a command failed, or work was handed to another thread. The group label is a way to locate the action. The specific call's result shows its status.

The [thread workflow](/learn/threads/working-with-threads) explains where this review fits before settling a task or rewinding an earlier prompt.

## Read running and long command output

A running command's output updates live. Long output shows its most recent part, so the visible text may omit earlier lines. Avoid treating that excerpt as a complete transcript of every line the command printed.

Open the call to inspect its full command and available output. A shortened summary can hide shell-wrapper detail that matters when you are checking which directory, script, or arguments were used.

A summary can also continue describing the latest call after it finishes. Read the call's own result for the current status rather than inferring it from wording in the summary.

For example, when investigating a failed build, identify the actual build command, then read its exit code and available error text. If the result does not contain the needed explanation, ask the agent to investigate that gap. The summary alone does not establish the cause.

## Review file changes from their entries

Choose **Open diff** on a file-change entry. Review the contents that changed, then compare them with the requested task and the agent's explanation.

A command result and a diff answer different questions. The result describes what a command reported. The diff shows the file change you are reviewing. Neither a short assistant message nor an action count substitutes for reading the relevant evidence.

Use [source control and pull requests](/learn/workspace/source-control) for the larger review and shipping workflow. Use [messages and context](/learn/threads/messages-and-context) to attach a review comment or terminal excerpt to a follow-up instruction.

## Interpret orchestration counts

T3 Orchestrator summaries name the actions taken. A group might say **Ran 2 commands and sent messages to 3 threads**. If there were several messages to the same destinations, it reports both counts, such as **Sent 5 messages to 2 threads**.

Thread creation counts the threads the tool returns, including batches. That helps distinguish one creation call from the number of conversations it created. Failed calls do not count as successful messages or successful creations.

| Summary detail           | How to interpret it                                            |
| ------------------------ | -------------------------------------------------------------- |
| Message count            | Successful messages represented by the calls                   |
| Destination count        | Distinct threads that received those messages                  |
| Creation count           | Threads returned by successful creation tools                  |
| Broad action description | Details were unavailable, so the summary avoids an exact claim |

For groups with many activity types, the summary shows up to two specific categories plus a count of remaining actions. Commands, file changes, and orchestration changes take priority over reads and status checks. Expand the group to see the full list before deciding an omitted category did not occur.

## Separate a request from its outcome

Waiting on a thread does not mean it finished. An interrupt or cancellation request does not mean the target stopped. Look for the corresponding result before describing the operation as complete.

The distinction matters when you plan to restore files, start overlapping work, or rely on a delegated result. A request shows what the agent attempted to arrange. The result shows what was confirmed.

On web and desktop, **Agents** lets you follow subagent work. Agent-started subagent threads cannot accept your messages directly; address the parent thread instead. Stopping a parent also stops the subagents it delegated to. Use the activity and thread state to inspect how that work progressed.

For an unresolved approval, review [permission modes](/learn/safety/permission-modes). If the agent asks for missing evidence, [question attachments](/learn/threads/question-attachments) explains how to answer with files without replacing your normal draft.

## Next steps

- Send a focused follow-up with [messages and context](/learn/threads/messages-and-context), then use [working with threads](/learn/threads/working-with-threads) to organize the result.
- Start [issue triage](/learn/threads/triage) for a T3 Code failure, or return to [threads and messages](/learn/threads) for the other guides.
