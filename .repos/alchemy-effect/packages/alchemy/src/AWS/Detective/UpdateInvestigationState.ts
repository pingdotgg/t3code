import type * as detective from "@distilled.cloud/aws/detective";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for `detective:UpdateInvestigationState`.
 *
 * Moves an investigation between `ACTIVE` and `ARCHIVED` — close out a
 * triaged investigation from the same function that opened it. The graph
 * ARN is injected from the bound {@link Graph}.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.UpdateInvestigationStateHttp)`.
 * @binding
 * @section Running Investigations
 * @example Archive A Triaged Investigation
 * ```typescript
 * // init
 * const updateInvestigationState =
 *   yield* AWS.Detective.UpdateInvestigationState(graph);
 *
 * // runtime
 * yield* updateInvestigationState({ InvestigationId: id, State: "ARCHIVED" });
 * ```
 */
export interface UpdateInvestigationState extends Binding.Service<
  UpdateInvestigationState,
  "AWS.Detective.UpdateInvestigationState",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request: Omit<detective.UpdateInvestigationStateRequest, "GraphArn">,
    ) => Effect.Effect<
      detective.UpdateInvestigationStateResponse,
      detective.UpdateInvestigationStateError
    >
  >
> {}
export const UpdateInvestigationState =
  Binding.Service<UpdateInvestigationState>(
    "AWS.Detective.UpdateInvestigationState",
  );
