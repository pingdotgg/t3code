import type * as detective from "@distilled.cloud/aws/detective";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for `detective:GetInvestigation`.
 *
 * Reads a single investigation's detail — entity, scope window, status,
 * severity, and state — so a triage function can poll a running
 * investigation to completion. The graph ARN is injected from the bound
 * {@link Graph}.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.GetInvestigationHttp)`.
 * @binding
 * @section Running Investigations
 * @example Poll An Investigation
 * ```typescript
 * // init
 * const getInvestigation = yield* AWS.Detective.GetInvestigation(graph);
 *
 * // runtime
 * const detail = yield* getInvestigation({ InvestigationId: id });
 * if (detail.Status === "SUCCESSFUL") {
 *   yield* Effect.log(`severity: ${detail.Severity}`);
 * }
 * ```
 */
export interface GetInvestigation extends Binding.Service<
  GetInvestigation,
  "AWS.Detective.GetInvestigation",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request: Omit<detective.GetInvestigationRequest, "GraphArn">,
    ) => Effect.Effect<
      detective.GetInvestigationResponse,
      detective.GetInvestigationError
    >
  >
> {}
export const GetInvestigation = Binding.Service<GetInvestigation>(
  "AWS.Detective.GetInvestigation",
);
