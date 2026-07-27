import type * as featurestore from "@distilled.cloud/aws/sagemaker-featurestore-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FeatureGroup } from "./FeatureGroup.ts";

export interface ListRecordsRequest extends Omit<
  featurestore.ListRecordsRequest,
  "FeatureGroupName"
> {}

/**
 * Runtime binding for `sagemaker:ListRecords` — list the record-identifier
 * values stored in a `FeatureGroup`'s online store.
 *
 * Bind this operation to a `FeatureGroup` inside a function runtime to get a
 * callable that automatically injects the feature group name. Use it to
 * discover which records exist without retrieving the full record data;
 * paginate with `NextToken`.
 * @binding
 * @section Listing Records
 * @example List Record Identifiers
 * ```typescript
 * // init
 * const listRecords = yield* AWS.SageMaker.ListRecords(featureGroup);
 *
 * // runtime
 * const { RecordIdentifiers } = yield* listRecords({ MaxResults: 100 });
 * ```
 */
export interface ListRecords extends Binding.Service<
  ListRecords,
  "AWS.SageMaker.ListRecords",
  <F extends FeatureGroup>(
    featureGroup: F,
  ) => Effect.Effect<
    (
      request?: ListRecordsRequest,
    ) => Effect.Effect<
      featurestore.ListRecordsResponse,
      featurestore.ListRecordsError
    >
  >
> {}
export const ListRecords = Binding.Service<ListRecords>(
  "AWS.SageMaker.ListRecords",
);
