import type * as entityresolution from "@distilled.cloud/aws/entityresolution";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MatchingWorkflow } from "./MatchingWorkflow.ts";

/**
 * Runtime binding for `entityresolution:GenerateMatchId`.
 *
 * Generates or retrieves Match IDs for records submitted in real time
 * against the bound rule-based matching workflow: existing records return
 * their Match IDs, unmatched records get new ones. Provide the
 * implementation with `Effect.provide(AWS.EntityResolution.GenerateMatchIdHttp)`.
 * @binding
 * @section Real-Time Matching
 * @example Generate Match IDs for Records
 * ```typescript
 * // init — bind the operation to the workflow
 * const generateMatchId = yield* AWS.EntityResolution.GenerateMatchId(workflow);
 *
 * // runtime
 * const { matchGroups } = yield* generateMatchId({
 *   records: [
 *     {
 *       inputSourceARN: table.tableArn,
 *       uniqueId: "1",
 *       recordAttributeMap: { id: "1", email: "jane@example.com" },
 *     },
 *   ],
 * });
 * ```
 */
export interface GenerateMatchId extends Binding.Service<
  GenerateMatchId,
  "AWS.EntityResolution.GenerateMatchId",
  (
    workflow: MatchingWorkflow,
  ) => Effect.Effect<
    (
      request: Omit<entityresolution.GenerateMatchIdInput, "workflowName">,
    ) => Effect.Effect<
      entityresolution.GenerateMatchIdOutput,
      entityresolution.GenerateMatchIdError
    >
  >
> {}

export const GenerateMatchId = Binding.Service<GenerateMatchId>(
  "AWS.EntityResolution.GenerateMatchId",
);
