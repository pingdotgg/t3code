import type * as featurestore from "@distilled.cloud/aws/sagemaker-featurestore-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FeatureGroup } from "./FeatureGroup.ts";

export interface BatchGetRecordRequest {
  /**
   * The record-identifier values to retrieve from the bound feature group.
   */
  RecordIdentifiersValueAsString: string[];
  /**
   * Restrict the returned features to this subset (all features by default).
   */
  FeatureNames?: string[];
  /**
   * Include each record's `ExpiresAt` in the response (`"Enabled"`).
   */
  ExpirationTimeResponse?: featurestore.ExpirationTimeResponse;
}

/**
 * Runtime binding for `sagemaker:BatchGetRecord` — read a batch of records
 * from a `FeatureGroup`'s online store in one call.
 *
 * Bind this operation to a `FeatureGroup` inside a function runtime to get a
 * callable that automatically scopes the batch identifiers to the bound
 * feature group. Unknown identifiers are simply absent from `Records` (they
 * are not errors).
 * @binding
 * @section Reading Records
 * @example Batch-Get Records
 * ```typescript
 * // init
 * const batchGetRecord = yield* AWS.SageMaker.BatchGetRecord(featureGroup);
 *
 * // runtime
 * const { Records } = yield* batchGetRecord({
 *   RecordIdentifiersValueAsString: ["user-1", "user-2"],
 * });
 * ```
 */
export interface BatchGetRecord extends Binding.Service<
  BatchGetRecord,
  "AWS.SageMaker.BatchGetRecord",
  <F extends FeatureGroup>(
    featureGroup: F,
  ) => Effect.Effect<
    (
      request: BatchGetRecordRequest,
    ) => Effect.Effect<
      featurestore.BatchGetRecordResponse,
      featurestore.BatchGetRecordError
    >
  >
> {}
export const BatchGetRecord = Binding.Service<BatchGetRecord>(
  "AWS.SageMaker.BatchGetRecord",
);
