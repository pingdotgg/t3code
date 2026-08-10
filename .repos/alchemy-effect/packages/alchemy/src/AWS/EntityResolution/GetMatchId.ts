import type * as entityresolution from "@distilled.cloud/aws/entityresolution";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MatchingWorkflow } from "./MatchingWorkflow.ts";

/**
 * Runtime binding for `entityresolution:GetMatchId`.
 *
 * Returns the Match ID of a customer record if it has already been processed
 * by the bound rule-based matching workflow — a read-only dry run of an
 * incremental load. Provide the implementation with
 * `Effect.provide(AWS.EntityResolution.GetMatchIdHttp)`.
 * @binding
 * @section Real-Time Matching
 * @example Look Up a Record's Match ID
 * ```typescript
 * // init — bind the operation to the workflow
 * const getMatchId = yield* AWS.EntityResolution.GetMatchId(workflow);
 *
 * // runtime
 * const { matchId, matchRule } = yield* getMatchId({
 *   record: { id: "1", email: "jane@example.com" },
 * });
 * ```
 */
export interface GetMatchId extends Binding.Service<
  GetMatchId,
  "AWS.EntityResolution.GetMatchId",
  (
    workflow: MatchingWorkflow,
  ) => Effect.Effect<
    (
      request: Omit<entityresolution.GetMatchIdInput, "workflowName">,
    ) => Effect.Effect<
      entityresolution.GetMatchIdOutput,
      entityresolution.GetMatchIdError
    >
  >
> {}

export const GetMatchId = Binding.Service<GetMatchId>(
  "AWS.EntityResolution.GetMatchId",
);
