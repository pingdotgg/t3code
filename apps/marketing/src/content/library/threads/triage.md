---
title: "Triage an issue with an agent"
description: "Use T3 Code issue triage to investigate logs, state, matching source, and known issues, then review a proposed fix or GitHub issue before action."
updated: 2026-11-04
sources:
  - label: "Triage an issue"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/triage.md"
  - label: "Working with threads"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md"
  - label: "Activity log"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/activity-log.md"
faq:
  - question: "How do I diagnose a T3 Code problem from the app?"
    answer: "Open the T3 Code command palette and choose Triage an issue. Describe the problem after the linked playbook, choose a provider, and send the message."
  - question: "What if T3 Code will not start?"
    answer: "Run npx t3 triage in a terminal. It starts Claude Code or Codex with the same triage instructions used by the app."
  - question: "Does T3 Code triage apply fixes automatically?"
    answer: "T3 Code triage asks before applying a fix or posting anything. Because the agent runs inside the affected T3 Code server, it gives you restart steps rather than restarting that server itself."
  - question: "Which machine does T3 Code triage inspect?"
    answer: "T3 Code uses the machine of your open thread or draft. With neither open, it uses your primary machine if supported, or the first connected machine that supports triage."
---

T3 Code issue triage lets your coding agent investigate a problem using machine logs, saved state, source for the server's version, and known issues. It can help prepare a GitHub issue and asks before applying a fix or posting anything.

## Start triage from the app

1. Open a thread or draft on the machine where the problem occurs.
2. Open the command palette and choose **Triage an issue**.
3. Check the machine name on the new thread.
4. Describe what happened after the linked triage playbook.
5. Choose a provider and send the message.

T3 Code creates a new thread without a project. It fetches the source for that server's version while you write. The linked playbook supplies the investigation instructions, while your description identifies the problem to investigate.

You can choose any provider in the app's triage thread. The terminal fallback uses Claude Code or Codex. Keep the distinction in mind if you are following instructions for a provider that is available only in one of those paths.

The [thread workflow](/learn/threads/working-with-threads) explains how project-free threads work. Triage is a concrete use for one: the investigation concerns the running T3 Code environment rather than a feature in your current repository.

## Confirm the affected machine first

Triage runs on the machine of the thread or draft you have open. With nothing open, it chooses your primary machine if that machine supports triage. Otherwise, it chooses the first connected machine that does.

The new thread shows the selected machine name. On mobile, the command palette row shows it before you start. Read that name before sending a report about a remote problem.

For example, if a thread on another computer lost its connection, start from that thread's environment when available. An investigation on your laptop may not inspect the state that produced the remote failure. Use [T3 Connect troubleshooting](/learn/remote/t3-connect-troubleshooting) when the connection itself prevents you reaching the affected environment.

## Describe the failure as a sequence

The following is a suggested report structure. Replace each placeholder with your observations:

```text
I was doing [task] on [machine].
I expected [result].
Instead, I saw [exact behavior or error].
It started after [action or update, if known].
I can reproduce it by [steps].
Investigate the cause and explain the proposed next step.
```

Separate what you observed from what you suspect. If a reconnect happened near a failed turn, report the order rather than asserting that one caused the other. Include the exact error when you have it, and say when a problem is intermittent.

Give the agent enough detail to distinguish the app problem from the coding task it was running. A failing project test and a T3 Code thread that never updates its status can require different investigations, even when they happen together.

## Read the investigation before choosing a fix

Triage can read logs and machine state, inspect the matching T3 Code source, and look for known issues. It can help you write a useful GitHub issue when the problem needs maintainer attention.

Review the findings for a clear account of the symptom, supporting evidence, and proposed next step. If the report jumps from one error to a broad explanation, ask which log or state observation supports that conclusion.

Use the [activity log](/learn/threads/activity-log) to inspect available commands, output, status, and exit codes. An expandable summary helps locate the investigation's actions; the individual results provide the evidence you can assess.

| Proposed next step     | What to review                                  |
| ---------------------- | ----------------------------------------------- |
| Apply a fix            | Which files or settings would change and why    |
| Post an issue          | The report text and included diagnostic details |
| Restart the server     | The supplied restart instructions               |
| Continue investigating | The unresolved question and evidence needed     |

Triage asks before applying fixes or posting. A request to investigate does not mean the diagnosis itself has already changed the installation.

## Use the terminal when the app cannot help

If the app will not start, or in-app triage does not work, run:

```sh
npx t3 triage
```

This starts Claude Code or Codex in your terminal with the same instructions. Use it to reach the investigation workflow without depending on a functioning app interface.

For problems in a remote environment, keep the investigation tied to the machine that runs that environment. Do not assume a local terminal session has the remote server's logs and database.

The triage agent runs inside the T3 Code server it investigates when started through the app. It supplies restart steps instead of performing the restart itself. Follow those steps when you are ready, since the investigation cannot stay attached through its own server shutdown.

## Next steps

- Inspect the investigation in the [activity log](/learn/threads/activity-log) and review any code changes with [source control](/learn/workspace/source-control).
- For missing older conversations, read [thread migration](/learn/threads/thread-migration), or return to [threads and messages](/learn/threads).
