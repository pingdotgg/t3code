import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Revision } from "./Revision.ts";

/**
 * Runtime binding for `dataexchange:DeleteAsset`.
 *
 * Deletes an asset from the bound (not-yet-finalized) revision. The
 * data set and revision ids are injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.DeleteAssetHttp)`.
 * @binding
 * @section Managing Assets
 * @example Remove A Bad Import
 * ```typescript
 * const deleteAsset = yield* AWS.DataExchange.DeleteAsset(revision);
 *
 * // runtime
 * yield* deleteAsset({ AssetId: assetId });
 * ```
 */
export interface DeleteAsset extends Binding.Service<
  DeleteAsset,
  "AWS.DataExchange.DeleteAsset",
  (
    revision: Revision,
  ) => Effect.Effect<
    (
      request: Omit<
        dataexchange.DeleteAssetRequest,
        "DataSetId" | "RevisionId"
      >,
    ) => Effect.Effect<
      dataexchange.DeleteAssetResponse,
      dataexchange.DeleteAssetError
    >
  >
> {}
export const DeleteAsset = Binding.Service<DeleteAsset>(
  "AWS.DataExchange.DeleteAsset",
);
