import type * as featurestore from "@distilled.cloud/aws/sagemaker-featurestore-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FeatureGroup } from "./FeatureGroup.ts";

export interface GetRecordRequest extends Omit<
  featurestore.GetRecordRequest,
  "FeatureGroupName"
> {}

/**
 * Runtime binding for `sagemaker:GetRecord` — read the latest record for an
 * identifier from a `FeatureGroup`'s online store.
 *
 * Bind this operation to a `FeatureGroup` inside a function runtime to get a
 * callable that automatically injects the feature group name. If no record
 * exists for the identifier, the response's `Record` is empty.
 * @binding
 * @section Reading Records
 * @example Get a Record
 * ```typescript
 * // init
 * const getRecord = yield* AWS.SageMaker.GetRecord(featureGroup);
 *
 * // runtime
 * const { Record } = yield* getRecord({
 *   RecordIdentifierValueAsString: "user-123",
 * });
 * ```
 */
export interface GetRecord extends Binding.Service<
  GetRecord,
  "AWS.SageMaker.GetRecord",
  <F extends FeatureGroup>(
    featureGroup: F,
  ) => Effect.Effect<
    (
      request: GetRecordRequest,
    ) => Effect.Effect<
      featurestore.GetRecordResponse,
      featurestore.GetRecordError
    >
  >
> {}
export const GetRecord = Binding.Service<GetRecord>("AWS.SageMaker.GetRecord");
