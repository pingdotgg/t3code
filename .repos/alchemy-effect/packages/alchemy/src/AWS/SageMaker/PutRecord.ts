import type * as featurestore from "@distilled.cloud/aws/sagemaker-featurestore-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FeatureGroup } from "./FeatureGroup.ts";

export interface PutRecordRequest extends Omit<
  featurestore.PutRecordRequest,
  "FeatureGroupName"
> {}

/**
 * Runtime binding for `sagemaker:PutRecord` — write a record to a
 * `FeatureGroup`'s online store (and, when configured, its offline store).
 *
 * Bind this operation to a `FeatureGroup` inside a function runtime to get a
 * callable that automatically injects the feature group name. Every feature
 * value is passed as a string (`ValueAsString`) — the feature group's schema
 * declares the actual types.
 * @binding
 * @section Writing Records
 * @example Put a Record
 * ```typescript
 * // init
 * const putRecord = yield* AWS.SageMaker.PutRecord(featureGroup);
 *
 * // runtime
 * yield* putRecord({
 *   Record: [
 *     { FeatureName: "user_id", ValueAsString: "user-123" },
 *     { FeatureName: "event_time", ValueAsString: new Date().toISOString() },
 *     { FeatureName: "clicks", ValueAsString: "42" },
 *   ],
 * });
 * ```
 */
export interface PutRecord extends Binding.Service<
  PutRecord,
  "AWS.SageMaker.PutRecord",
  <F extends FeatureGroup>(
    featureGroup: F,
  ) => Effect.Effect<
    (
      request: PutRecordRequest,
    ) => Effect.Effect<
      featurestore.PutRecordResponse,
      featurestore.PutRecordError
    >
  >
> {}
export const PutRecord = Binding.Service<PutRecord>("AWS.SageMaker.PutRecord");
