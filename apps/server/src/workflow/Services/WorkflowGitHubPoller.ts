import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface WorkflowGitHubPollerSweepResult {
  // Watched tickets observed this sweep (pr_state='open', non-terminal).
  readonly observedTickets: number;
  // New observation rows inserted (deduped by dedup_key).
  readonly recordedObservations: number;
  // Pending observations marked 'applied' in phase 2.
  readonly appliedObservations: number;
  // Watched tickets whose gh observation failed (logged + skipped).
  readonly failedTickets: number;
}

export interface WorkflowGitHubPollerShape {
  readonly sweep: () => Effect.Effect<WorkflowGitHubPollerSweepResult>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class WorkflowGitHubPoller extends Context.Service<
  WorkflowGitHubPoller,
  WorkflowGitHubPollerShape
>()("t3/workflow/Services/WorkflowGitHubPoller") {}
