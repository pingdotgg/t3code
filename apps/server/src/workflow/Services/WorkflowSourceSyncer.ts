import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

// The syncer fiber: a background loop that, each tick ("sweep"), pulls every
// registered board's enabled work sources, diffs them against the stored
// mappings, and drives the committer to admit/edit/close/orphan tickets.
//
// - `sweep` runs ONE full pass over all boards/sources and returns when done.
//   Per-source failures are isolated (one source failing never aborts the
//   sweep) and recorded as backoff in `work_source_state`.
// - `start()` forks the sweep loop on a fixed schedule under the current scope
//   (mirrors WorkflowGitHubPoller). Wiring is Task 16; here we only expose it.
export interface WorkflowSourceSyncerShape {
  readonly sweep: Effect.Effect<void, never>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class WorkflowSourceSyncer extends Context.Service<
  WorkflowSourceSyncer,
  WorkflowSourceSyncerShape
>()("t3/workflow/Services/WorkflowSourceSyncer") {}
