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

## Pull request bases

Worktree creation records each new branch's `gh-merge-base` as the branch it
came from, which would point a branch-end PR at an inner node's branch that has
no PR of its own. Delivery passes `baseBranch` to `runStackedAction` instead,
from `taskGraphPullRequestBase`: the nearest ancestor along first dependencies
that opens its own PR, skipping nodes that share the branch, else the graph
base. The same value goes to peers, so stacks work across machines.

## Usage limits

A run that hits a usage limit ends `failed`, with the reset on its failure turn
item. For a node, `finishLocalNode` reads that, moves the node to `waiting`, and
arms the thread's `limitRecovery` with `autoResume`, so the existing
`UsageLimitRecoveryWorker` continues the thread at the reset regardless of the
user's global auto-resume setting. The node wakes on that new run's first
active `run.updated`. Cancelling a waiting node clears the recovery, or the
worker would resume it and the node would come back. Before a launch, a local
node whose provider instance reports a used-up window waits for `resetsAt`.
Nodes on peers do neither yet: a limit there fails the node.

## Peers

A peer is another environment this server holds a session on.

- **Adding through a client:** a client connected to both machines asks the
  peer for a grant (`taskGraphPeers.issueGrant`), a five-minute pairing
  credential limited to `TASK_GRAPH_PEER_SCOPES` that the caller must already
  hold. It hands that to this server with the address it reaches the peer at.
  For a T3 Connect connection that is the tunnel hostname, which forwards plain
  HTTP and WebSocket to the peer, so the server never needs T3 Connect
  credentials of its own; the peer's own auth accepts the bearer session.
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
