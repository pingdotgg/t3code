---
name: architect
description: "Sketch types, signatures, and module structure before code, then stay in the loop while implementation fills in. Use for $pstack:architect, 'architect this', 'design this', or non-trivial work where jumping to code would lock in the wrong shape."
disable-model-invocation: true
---

# Architect

Use `delegate_task` for every spawn. Arena runners, architect runners, and interrogate reviewers are panels: one child per seat, including fallbacks. An `unavailable` seat is not a target: retain its panel position, refresh capabilities, report the blocked seat, and do not launch it until a valid target is resolved. Every other role is a pool: pick the seat whose model best fits the job; spread same-role children in a wave across seats. Arena cross-judges prefer a different model family. Copy the chosen target from `<t3_pstack>` exactly, including all options; `inherit` means the parent model and omits `target`. If a pool spawn is rejected, report it and try the next seat; never invent targets or change options. Repeat fallback notes and report provider, model, or option mismatches. If a required role is missing, stop that spawn. Call `orchestrator_capabilities` before the first delegation and again when availability changes or a target is rejected. Resolved roles are a snapshot. An explicit user change supersedes it; validate the requested target and options against fresh capabilities. After setup writes new choices, do not reuse the older snapshot for changed roles. Start each brief with `Read <pstack>/skills/poteto-mode/worker.md before anything else.`, using the absolute pack path. Then give the absolute pack and models paths and any resolved roles the child needs to delegate. Retain every `taskId`. With `mode: "async"`, spawn the wave and end the turn; completion wakes the parent. Do not poll children. Use `mode: "wait"` only when this turn needs the result; a wait timeout does not cancel the child. Cancel replaced or unneeded work with `task_cancel`.

Trace every system the change touches. Sketch two distinct shapes before writing code. Start each sketch with caller usage, then give the types, signatures, and module boundaries that support it. Choose the shape where every state has one owner and callers need to know least about the implementation.

For a large or contested design, run **arena** with every resolved `architect runners` seat in place of `arena runners`. Give each runner the grounding evidence and ask for the same sketch. Keep the panel size and the Arena lifecycle and isolation rules.

If the user asks to review the design before implementation, show the sketch and pause. If implementation keeps exposing the same workaround, trace the new constraint and redesign before continuing.
