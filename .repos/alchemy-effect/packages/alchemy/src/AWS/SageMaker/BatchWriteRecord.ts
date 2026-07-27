import type * as featurestore from "@distilled.cloud/aws/sagemaker-featurestore-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FeatureGroup } from "./FeatureGroup.ts";

export interface BatchWriteRecordEntry extends Omit<
  featurestore.BatchWriteRecordEntry,
  "FeatureGroupName"
> {}

export interface BatchWriteRecordRequest {
  /**
   * The records to ingest into the bound feature group. Each entry may set
   * its own `TargetStores` / `TtlDuration`.
   */
  Entries: BatchWriteRecordEntry[];
  /**
   * Request-level TTL applied to entries that do not specify their own.
   */
  TtlDuration?: featurestore.TtlDuration;
}

/**
 * Runtime binding for `sagemaker:BatchWriteRecord` — bulk-ingest records
 * into a `FeatureGroup`'s online (and offline) store in one call.
 *
 * Bind this operation to a `FeatureGroup` inside a function runtime to get a
 * callable that automatically scopes every entry to the bound feature group.
 * Per-record failures come back in the response's `Errors` /
 * `UnprocessedEntries` rather than failing the whole call.
 * @binding
 * @section Writing Records
 * @example Batch-Write Records
 * ```typescript
 * // init
 * const batchWriteRecord = yield* AWS.SageMaker.BatchWriteRecord(featureGroup);
 *
 * // runtime
 * const { Errors } = yield* batchWriteRecord({
 *   Entries: [
 *     {
 *       Record: [
 *         { FeatureName: "user_id", ValueAsString: "user-1" },
 *         { FeatureName: "event_time", ValueAsString: new Date().toISOString() },
 *         { FeatureName: "clicks", ValueAsString: "1" },
 *       ],
 *     },
 *   ],
 * });
 * ```
 */
export interface BatchWriteRecord extends Binding.Service<
  BatchWriteRecord,
  "AWS.SageMaker.BatchWriteRecord",
  <F extends FeatureGroup>(
    featureGroup: F,
  ) => Effect.Effect<
    (
      request: BatchWriteRecordRequest,
    ) => Effect.Effect<
      featurestore.BatchWriteRecordResponse,
      featurestore.BatchWriteRecordError
    >
  >
> {}
export const BatchWriteRecord = Binding.Service<BatchWriteRecord>(
  "AWS.SageMaker.BatchWriteRecord",
);
