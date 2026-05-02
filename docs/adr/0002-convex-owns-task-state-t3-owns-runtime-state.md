# Convex owns Task state, T3 owns runtime state

The AI Engineer needs a Task model that spans the Workspace, Linear, Slack, GitHub Pull Requests, and the sandboxed coding runtime. We decided that the Convex Orchestrator owns Task identity, Task Status, Team App links, mute state, and the current Primary Thread pointer, while T3 Code owns local Project, Worktree, Thread, and Coding Agent runtime state and reports lifecycle changes back to Convex. This intentionally allows `apps/orchestrator` to be refactored away from its current Linear-MVP bridge shape into the durable brain of the product.
