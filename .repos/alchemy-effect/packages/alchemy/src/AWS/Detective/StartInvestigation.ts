import type * as detective from "@distilled.cloud/aws/detective";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for `detective:StartInvestigation`.
 *
 * Kicks off a Detective investigation into an IAM user or role over a time
 * window — the programmatic version of the console's "Run investigation"
 * button. A security-automation function can trigger triage the moment a
 * GuardDuty finding lands. The graph ARN is injected from the bound
 * {@link Graph}.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.StartInvestigationHttp)`.
 * @binding
 * @section Running Investigations
 * @example Investigate A Suspicious Role
 * ```typescript
 * // init — bind the operation to the behavior graph
 * const startInvestigation = yield* AWS.Detective.StartInvestigation(graph);
 *
 * // runtime
 * const { InvestigationId } = yield* startInvestigation({
 *   EntityArn: suspiciousRoleArn,
 *   ScopeStartTime: new Date(Date.now() - 24 * 60 * 60 * 1000),
 *   ScopeEndTime: new Date(),
 * });
 * ```
 */
export interface StartInvestigation extends Binding.Service<
  StartInvestigation,
  "AWS.Detective.StartInvestigation",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request: Omit<detective.StartInvestigationRequest, "GraphArn">,
    ) => Effect.Effect<
      detective.StartInvestigationResponse,
      detective.StartInvestigationError
    >
  >
> {}
export const StartInvestigation = Binding.Service<StartInvestigation>(
  "AWS.Detective.StartInvestigation",
);
