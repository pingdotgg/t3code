# Task graphs

A task graph is a plan of agent tasks with dependencies, owned by the thread
that proposed it. User docs: [Task graphs](../user/task-graphs.md).

## Outside the orchestrator, on purpose

`TaskGraphService` (`apps/server/src/taskGraph/`) is a client of orchestration,
not part of it. It launches node threads through `ThreadLaunchService`, learns
that a node ended from `run.updated` in the domain event stream, and reports
back through `sendToThread`. The orchestrator never sees a graph.

Two reasons. Starting a node is multi-step I/O: worktree provisioning, setup
scripts and branch naming already live in `ThreadLaunchService`, and delivery
is `GitWorkflowService.runStackedAction`. Neither belongs in the pure decider.
And a node on a peer machine is a thread on a different server, which the local
event log cannot hold anyway.

The cost is that graph state is not event-sourced. A graph is one JSON row
written whole under a single lock. Node launches are keyed by a command ID
derived from the node's pre-allocated thread ID, so recovery after a crash can
repeat a launch safely. A node recorded `running` before its launch committed
is launched again on startup.

## Edits are one code path

Agents (MCP `task_graph_*` tools), the web editor and mobile all send the same
`TaskGraphEdit` operations, checked by `applyTaskGraphEdits` in
`@t3tools/shared/taskGraph`. Clients run it first for instant errors; the
server's run is the one that counts.

## Peers

A peer is another environment this server holds a session on.

- **Pairing:** pairing exchanges a normal pairing link at the peer's
  `/oauth/token`, narrowed to `orchestration:read`, `orchestration:operate`
  and `source-control:write`, as a `bot` client. The token lives in the secret
  store, never in the `task_graph_peers` table. Removing a peer forgets the
  token; revoking the session is the peer owner's job.
- **Limits:** bearer sessions carry no runtime-mode ceiling. A node on a peer
  runs in the proposing thread's mode, so pairing a peer means trusting this
  machine's agents with that mode there.
- **Branches:** they move through the shared remote. While any peer is
  paired, every node pushes its branch, because placement happens after a
  dependency finishes and the dependent may land anywhere. A node whose first
  dependency ran elsewhere starts from origin.
- **Placement:** uses `chooseLoadBalancedEnvironment` from
  `@t3tools/shared/loadBalancing`, the same scorer client load balancing uses.
  This machine counts as one candidate, gated by `taskGraphMaxConcurrentNodes`.
