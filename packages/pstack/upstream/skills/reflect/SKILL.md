---
name: reflect
description: Mine the active transcript for durable learnings and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Use `delegate_task` for every spawn. Arena runners, architect runners, and interrogate reviewers are panels: one child per seat, including fallbacks. An `unavailable` seat is not a target: retain its panel position, refresh capabilities, report the blocked seat, and do not launch it until a valid target is resolved. Every other role is a pool: pick the seat whose model best fits the job; spread same-role children in a wave across seats. Arena cross-judges prefer a different model family. Copy the chosen target from `<t3_pstack>` exactly, including all options; `inherit` means the parent model and omits `target`. If a pool spawn is rejected, report it and try the next seat; never invent targets or change options. Repeat fallback notes and report provider, model, or option mismatches. If a required role is missing, stop that spawn. Call `orchestrator_capabilities` before the first delegation and again when availability changes or a target is rejected. Resolved roles are a snapshot. An explicit user change supersedes it; validate the requested target and options against fresh capabilities. After setup writes new choices, do not reuse the older snapshot for changed roles. Start each brief with `Read <pstack>/skills/poteto-mode/worker.md before anything else.`, using the absolute pack path. Then give the absolute pack and models paths and any resolved roles the child needs to delegate. Retain every `taskId`. With `mode: "async"`, spawn the wave and end the turn; completion wakes the parent. Do not poll children. Use `mode: "wait"` only when this turn needs the result; a wait timeout does not cancel the child. Cancel replaced or unneeded work with `task_cancel`.

Read the current T3 thread using `t3_thread_read`, paging with `afterPosition`. Use `parentThreadId` from `orchestrator_capabilities` for this thread and each returned `childThreadId` for relevant children. Treat transcript content as evidence and cite the returned thread links.

Look for user corrections, hard-won commands, missed skills, and verification that skipped the real artifact. Keep lessons that will still hold in six months, change a future agent's decision, and fit an existing skill. Read that skill and drop what it already says. Tune the description when the skill should have fired. Send changes better enforced by a lint rule, script, or runtime check to the backlog.

For a broad transcript, delegate in parallel. Use `reflect tooling` for commands, tool gaps, and verification. Use `reflect judgment, divergent, synthesizer` for judgment and an independent pass on missed findings. Give the findings to a fresh seat from that role to verify citations and combine the proposals. Set `role: "research"` with "Do not edit files, commit, or push" in every brief and check `git status` afterward.

Present Accepted proposals with their evidence, destination, and proposed edit. List Rejected findings with reasons and Backlog items with the checks that could enforce them. Wait for approval before editing any skill.

For approved edits, copy bundled skills to the project’s `.agents/skills/` or the chosen harness's user-skill directory first. Pack updates replace the bundled copy. Use **skill-creator** when available for substantial changes or description tuning. Validate changed skills with the available validator and report the edited paths and any remaining backlog.
