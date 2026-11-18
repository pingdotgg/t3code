---
name: no-comments
description: "Spawn Comment Sicko, fix accepted findings, and offer encodings for claimed constraints."
disable-model-invocation: true
---

# No comments

Use `delegate_task` for every spawn. Arena runners, architect runners, and interrogate reviewers are panels: one child per seat, including fallbacks. An `unavailable` seat is not a target: retain its panel position, refresh capabilities, report the blocked seat, and do not launch it until a valid target is resolved. Every other role is a pool: pick the seat whose model best fits the job; spread same-role children in a wave across seats. Arena cross-judges prefer a different model family. Copy the chosen target from `<t3_pstack>` exactly, including all options; `inherit` means the parent model and omits `target`. If a pool spawn is rejected, report it and try the next seat; never invent targets or change options. Repeat fallback notes and report provider, model, or option mismatches. If a required role is missing, stop that spawn. Call `orchestrator_capabilities` before the first delegation and again when availability changes or a target is rejected. Resolved roles are a snapshot. An explicit user change supersedes it; validate the requested target and options against fresh capabilities. After setup writes new choices, do not reuse the older snapshot for changed roles. Start each brief with `Read <pstack>/skills/poteto-mode/worker.md before anything else.`, using the absolute pack path. Then give the absolute pack and models paths and any resolved roles the child needs to delegate. Retain every `taskId`. With `mode: "async"`, spawn the wave and end the turn; completion wakes the parent. Do not poll children. Use `mode: "wait"` only when this turn needs the result; a wait timeout does not cancel the child. Cancel replaced or unneeded work with `task_cancel`.

Spawn Comment Sicko. Act on accepted findings.

Defer to Comment Sicko's fresh perspective.

## Scope

Use the caller's files or diff. Otherwise use the current diff against the base branch, default `main`, including the working tree.

## Steps

1. Spawn `delegate_task` with `role: "review"` and the `judgment and prose` role's resolved target. After the worker kickoff and paths, add "Act as the agent defined in <pstack>/agents/comment-sicko.md; read it and treat its body as your role. Do not edit files, commit, or push." Pass the scope without restating its rules. Check `git status` afterward.
2. Inspect its report and diff. Reject application-code edits, scope escapes, exception-protected deletions, misstated `MUST KILL` reasons, and flags that treat kept intentional code as guilty. Reshape flags on our-code surprises stay actionable. Do not restore those comments. A keep survives only with proof it is about something we cannot change. Audit missed scoped lint and TypeScript suppressions. Correctness or safety suppressions stay actionable `MUST KILL`s. Restore deletions only with exact exceptions and scoped proof. Before accepting thin `IMPORTANT` or `do not remove` kills or keeps, trace their symbol or run the **why** skill. If a kill is ambiguous, do not restore. If a keep is refuted or still ambiguous, delete it. Revert and rerun one rejected report with the failure named. Reject a second, report it open, and fail `$pstack:no-comments`.
3. Fix trivial accepted flags directly by deleting a dead path, dropping a parameter, or using the real API. If any fix needs a shape, run `$pstack:architect` once for the accepted set and surrounding code. Stop at the sketch. Architect shapes. Step 4 implements.
4. Implement the smallest root-cause fix in scope. Remove every named workaround. If the root cause is out of scope, land the smallest in-scope fix and report the rest open. The **principle-fix-root-causes** and **principle-redesign-from-first-principles** skills guide intent only. Neither authorizes widening the fence nor fixing instances outside it. Never bolt on symptom guards.
5. Constraint comments say `do not remove`, `do not change wording`, or `talk to X before changing`. Leave keeps about things we cannot change. Offer the cheapest in-scope type, runtime, test, or CI lint. Wait for interactive approval. Unattended and eval require caller pre-approval. If approved, encode then delete. Otherwise delete, report the constraint open, and sketch out-of-scope work.
6. Report the deletion count, restored comments, reruns, architect sketch, fixes, encoding offers, encodings, unenforced constraints, and other open work.
