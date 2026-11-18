---
name: recall
description: "Reconstruct your recent working context from your own chat history, live state, and the shared record (user reports, prior fixes, incidents), then hand back a tight current-state brief. Use for 'recall my work on X', 'catch me up', 'what have I been working on', 'where did I leave off', before starting or resuming work."
disable-model-invocation: true
---

# Recall

Use `delegate_task` for every spawn. Arena runners, architect runners, and interrogate reviewers are panels: one child per seat, including fallbacks. An `unavailable` seat is not a target: retain its panel position, refresh capabilities, report the blocked seat, and do not launch it until a valid target is resolved. Every other role is a pool: pick the seat whose model best fits the job; spread same-role children in a wave across seats. Arena cross-judges prefer a different model family. Copy the chosen target from `<t3_pstack>` exactly, including all options; `inherit` means the parent model and omits `target`. If a pool spawn is rejected, report it and try the next seat; never invent targets or change options. Repeat fallback notes and report provider, model, or option mismatches. If a required role is missing, stop that spawn. Call `orchestrator_capabilities` before the first delegation and again when availability changes or a target is rejected. Resolved roles are a snapshot. An explicit user change supersedes it; validate the requested target and options against fresh capabilities. After setup writes new choices, do not reuse the older snapshot for changed roles. Start each brief with `Read <pstack>/skills/poteto-mode/worker.md before anything else.`, using the absolute pack path. Then give the absolute pack and models paths and any resolved roles the child needs to delegate. Retain every `taskId`. With `mode: "async"`, spawn the wave and end the turn; completion wakes the parent. Do not poll children. Use `mode: "wait"` only when this turn needs the result; a wait timeout does not cancel the child. Cancel replaced or unneeded work with `task_cancel`.

**Before you start or resume work, you rebuild the user's recent working context and hand back a tight capsule of where things stand now and what to do next.**

Keep it tight and on-topic. Read only what the in-scope threads need, then stop.

Your context lives in two records. Your own chat history holds what you did and decided. The shared record holds everything that happened around the same code under other names: the symptoms users keep reporting, the fixes that shipped and got reverted, the errors still firing in prod. That second record lives in source control, the issue tracker, chat and issue channels, long-form docs, and error tracking. A feature with a long bug tail keeps most of its story there, so don't reconstruct it from your transcripts alone.

Use `orchestrator_capabilities` to identify this thread as `parentThreadId`. Find earlier threads only in the current project with `t3_thread_search` and `t3_conversation_summary_list`. Read each relevant thread with `t3_thread_read`, paging with `afterPosition`. Children are read by their returned `childThreadId`. Never read provider transcript files. Cite the returned link verbatim, or `[title](t3-thread://v1/<exact-id>)` when no link is returned.

1. Classify, then route. One specific prior chat to resume is the `session-pickup` playbook, not this. Turning habits into a durable skill is `automate-me`. A human-readable summary of your work is a different task. Recall loads working context across recent chats before you act. If the user already gave you a full state capsule (paths, branch, the change), use it and skip the mining.
2. Lock the scope before searching. Pin the window ("recent" is a real range, default the last 7 days), the topic if named, and the workspace (default the active one. Never read another project's transcripts without being asked). State the scope back. Never quietly turn "all" into "recent N".
3. Search project threads for the chosen window and topic, ordered by actual activity time. Exclude this thread and obvious eval or test noise. For one or two threads read directly. For larger histories delegate bounded thread sets using `how explorer`, with `role: "research"` and no-write briefs. Each returns topic, goal, decisions, unfinished work, corrections, and artifacts with thread links. Keep raw histories in children and only findings in the parent.
4. For a named feature, file, subsystem, or bug, sweep relevant shared records in parallel with thread history. Use resolved `why investigators` seats, one per independent source, with `role: "research"` and no-write briefs. Ask what is current, what was tried, and what problems remain. Fold cited findings and known source gaps into the brief. For a pure activity recap, use thread history and live state.
5. Verify against live state. Take the PRs, branches, and tickets that the mining and the sweep surfaced and check them with `git` and `gh`. When the answer hinges on what an agent actually did (the tools it ran, files it read, errors it hit), read the full transcript, not just a trimmed local copy.
6. Write the brief to the contract below. Group by thread. Stay on the named topic.

## Output contract

Lead with the capsule, then the thread status, then the problems, then the next move. Deeper detail goes below or gets cut.

- **Capsule.** At most 5 bullets. What this work is and where it stands overall.
- **Threads.** One line each, prefixed with exactly one status tag: `[merged #N]`, `[open PR #N]`, `[in flight <branch>]`, `[verified, uncommitted]`, `[reverted #N]`, or `[planned, not started]`. A thread with no tag is not done yet, so tag it.
- **Problems.** At most 5, the recurring ones. Include the symptoms users keep reporting and any fix that shipped and was reverted, so the next attempt starts where the last one failed.
- **Next move.** The single most useful next action, concrete.

An adjacent feature or ticket stays out unless it blocks this one. When the capsule and thread lines outgrow a screen, cut detail before you cut threads. Write the brief through the **unslop** skill, cite chat findings by UUID and shared-record findings by their source (PR #, ticket ID, chat permalink, error-tracker issue), and sanitize private context before any public output.

**Reply:** the brief, to the contract above.
