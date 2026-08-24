import type * as featurestore from "@distilled.cloud/aws/sagemaker-featurestore-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FeatureGroup } from "./FeatureGroup.ts";

export interface DeleteRecordRequest extends Omit<
  featurestore.DeleteRecordRequest,
  "FeatureGroupName"
> {}

/**
 * Runtime binding for `sagemaker:DeleteRecord` — delete a record from a
 * `FeatureGroup`'s online store.
 *
 * Bind this operation to a `FeatureGroup` inside a function runtime to get a
 * callable that automatically injects the feature group name. The default
 * `SoftDelete` mode nulls the feature columns; `HardDelete` removes the
 * record entirely. `EventTime` must be later than the stored record's event
 * time for the deletion to take effect.
 * @binding
 * @section Deleting Records
 * @example Soft-Delete a Record
 * ```typescript
 * // init
 * const deleteRecord = yield* AWS.SageMaker.DeleteRecord(featureGroup);
 *
 * // runtime
 * yield* deleteRecord({
 *   RecordIdentifierValueAsString: "user-123",
 *   EventTime: new Date().toISOString(),
 * });
 * ```
 */
export interface DeleteRecord extends Binding.Service<
  DeleteRecord,
  "AWS.SageMaker.DeleteRecord",
  <F extends FeatureGroup>(
    featureGroup: F,
  ) => Effect.Effect<
    (
      request: DeleteRecordRequest,
    ) => Effect.Effect<
      featurestore.DeleteRecordResponse,
      featurestore.DeleteRecordError
    >
  >
> {}
export const DeleteRecord = Binding.Service<DeleteRecord>(
  "AWS.SageMaker.DeleteRecord",
);
