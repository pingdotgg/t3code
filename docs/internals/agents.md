# Native Agent orchestration

T3 Agents are a provider-neutral orchestration layer built from existing T3 primitives. A child is an ordinary durable thread with a pinned profile revision; it is not a provider-native subagent. Providers only need to expose the capability declarations and accept the T3 MCP server already injected at their adapter boundary.

## Small model

The system has four durable concepts:

1. An **Agent profile** is policy: model selection, instructions, runtime/workspace/tool policy, delegation allowlist, Rules, hooks, requirements, and budgets.
2. An **AgentRun** is a pure state machine for one child execution. Its append-only events and projection are separate from the child thread's existing orchestration history.
3. A **profile snapshot** stores the exact document body keyed by its SHA-256 revision before execution.
4. A thread stores an optional pinned profile reference. Root and child turns use the same prompt-resolution path.

Project profiles and Rules are explicit `t3.json` references. The catalog never recursively scans a repository. Environment documents live under the server's own state directory. Catalog list calls read frontmatter only; bodies load when editing or compiling a prompt.

`chatSelectable` is presentation policy, not execution authorization. Web and mobile omit delegation-only profiles from new top-level chat choices, while the server catalog and `agent_list` retain them for orchestration. A currently pinned profile remains visible in its existing thread so changing the setting never disguises active state.

## Turn and run flow

```text
thread.turn.start
  → resolve pinned profile snapshot
  → match Rules and run promptBuild hooks
  → compile a provider-portable prompt
  → provider session receives the turn
  → model calls T3 MCP agent_spawn
  → validate delegation, provider guarantees, workspace, and lineage budget
  → persist AgentRun request and profile snapshot
  → create/start an ordinary child thread
  → provider runtime events advance AgentRun
  → agent_wait wakes on durable revision advance
  → agent_result returns bounded messages/diff/usage
  → optional isolated patch integration
```

The portable prompt has a version marker so a child task already compiled with handoff and lineage context is not wrapped twice.

## Invariants

- Maximum depth is 4, concurrency is 8, runs per lineage are 32, and wall time is 120 minutes.
- Child budgets are clamped to the parent budget.
- A profile allowlist requires exact native tool-policy enforcement; prompt-only claims are rejected.
- Selected profile revisions are immutable for a thread/run. Compare-and-swap writes prevent lost updates.
- Project paths are canonicalized and re-contained after symlink resolution.
- `agent_wait` subscribes before its durable read and uses revision cursors, avoiding races and polling.
- Repository dispatch replays only the target lineage, never all historical runs.
- Shared writes are bounded by profile policy. Isolated integration preflights repository identity, target cleanliness, untracked files, and patch applicability before mutation.

## Provider boundary

Every adapter declares Agent runtime capabilities: MCP injection, instruction delivery, native tool-policy enforcement, token usage, and monetary cost. Compatibility is deny-by-default when a declaration is absent. Orchestration and clients do not switch on provider kind.

Adding a future provider therefore requires an honest capability declaration and the normal MCP injection path, not a new Agent implementation.

## Multi-surface and remote behavior

Catalog and mutation operations are typed WebSocket RPCs scoped by environment authorization. Profile bodies are not broadcast in the orchestration snapshot. Web and mobile query the catalog on demand, while desktop inherits the web surface. Child threads, runs, and results live on the host server, so relay, tunnel, and LAN clients see the same state.

## Persistence

AgentRun commands are decided against replayed lineage state, appended transactionally, then projected in the same transaction. Provider events drive lifecycle transitions through a reactor. The child thread remains authoritative for conversation content and checkpoint diffs; AgentRun stores coordination state and usage rather than duplicating the transcript.
