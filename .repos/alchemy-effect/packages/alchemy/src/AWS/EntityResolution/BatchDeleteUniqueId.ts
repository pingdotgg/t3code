import type * as entityresolution from "@distilled.cloud/aws/entityresolution";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MatchingWorkflow } from "./MatchingWorkflow.ts";

/**
 * Runtime binding for `entityresolution:BatchDeleteUniqueId`.
 *
 * Deletes unique IDs (and their match associations) from the bound matching
 * workflow's internal match store. Provide the implementation with
 * `Effect.provide(AWS.EntityResolution.BatchDeleteUniqueIdHttp)`.
 * @binding
 * @section Real-Time Matching
 * @example Delete Records from the Match Store
 * ```typescript
 * // init — bind the operation to the workflow
 * const batchDeleteUniqueId = yield* AWS.EntityResolution.BatchDeleteUniqueId(workflow);
 *
 * // runtime
 * const { deleted, errors } = yield* batchDeleteUniqueId({
 *   uniqueIds: ["1", "2"],
 * });
 * ```
 */
export interface BatchDeleteUniqueId extends Binding.Service<
  BatchDeleteUniqueId,
  "AWS.EntityResolution.BatchDeleteUniqueId",
  (
    workflow: MatchingWorkflow,
  ) => Effect.Effect<
    (
      request: Omit<entityresolution.BatchDeleteUniqueIdInput, "workflowName">,
    ) => Effect.Effect<
      entityresolution.BatchDeleteUniqueIdOutput,
      entityresolution.BatchDeleteUniqueIdError
    >
  >
> {}

export const BatchDeleteUniqueId = Binding.Service<BatchDeleteUniqueId>(
  "AWS.EntityResolution.BatchDeleteUniqueId",
);
