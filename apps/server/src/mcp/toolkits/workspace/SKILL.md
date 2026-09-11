---
name: t3-workspace
description: Operate T3 Code projects and threads through an external environment-local MCP connection.
---

# T3 workspace control

Use `list_threads` to resolve a requested thread and `get_thread` to summarize it. Keep spoken replies short; do not read code, diffs, or transcripts aloud. Use `list_projects` and `list_providers` before starting work when the target is unclear.

Only call `settle_thread` when the user asks to settle or archive a finished task. Never infer consent because work looks done. In this workflow, “archive this finished task” means settle, preserving history and artifacts, not `thread.archive` or delete. Workspace settlement needs no additional confirmation flag: the user's request supplies consent.

A running or starting session, pending approval/user input, queued turn start, or archived thread returns `conflict`. Explain the blocker and that a rejected settle leaves history unchanged. Never interrupt automatically. There is no deferred settle and no self-settle while the target agent produces its turn. Retry only after the blocker clears. Repeated settlement is safe.

Use `unsettle_thread` when asked to restore a settled task to active. It does not send a message or start work.

Workspace MCP controls only its hosting environment. To act on desktop-pc, connect to desktop-pc's endpoint. The packaged gateway instead routes with `environmentId`, requires a lifecycle grant, and retains `confirmed: true` for settlement. Handoff does not authorize settling its source.

Before accepting an approval, restate the risk and wait for an explicit yes, then use `respond_to_approval` with `confirmed: true`.
