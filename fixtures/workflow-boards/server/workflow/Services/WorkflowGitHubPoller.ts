import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface WorkflowGitHubPollerSweepResult {
  readonly observedTickets: number;
  readonly recordedObservations: number;
  readonly appliedObservations: number;
  readonly failedTickets: number;
}

export interface WorkflowGitHubPollerShape {
  readonly sweep: () => Effect.Effect<WorkflowGitHubPollerSweepResult>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class WorkflowGitHubPoller extends Context.Service<
  WorkflowGitHubPoller,
  WorkflowGitHubPollerShape
>()("@t3tools/fixture-workflow-boards/server/workflow/Services/WorkflowGitHubPoller") {}
