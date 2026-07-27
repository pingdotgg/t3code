import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Revision } from "./Revision.ts";

/**
 * Runtime binding for `dataexchange:UpdateAsset`.
 *
 * Renames an asset of the bound revision (the asset name is the S3 key
 * used when subscribers export it). The data set and revision ids are
 * injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.UpdateAssetHttp)`.
 * @binding
 * @section Managing Assets
 * @example Rename An Imported Asset
 * ```typescript
 * const updateAsset = yield* AWS.DataExchange.UpdateAsset(revision);
 *
 * // runtime
 * yield* updateAsset({ AssetId: assetId, Name: "prices/2026-07-14.csv" });
 * ```
 */
export interface UpdateAsset extends Binding.Service<
  UpdateAsset,
  "AWS.DataExchange.UpdateAsset",
  (
    revision: Revision,
  ) => Effect.Effect<
    (
      request: Omit<
        dataexchange.UpdateAssetRequest,
        "DataSetId" | "RevisionId"
      >,
    ) => Effect.Effect<
      dataexchange.UpdateAssetResponse,
      dataexchange.UpdateAssetError
    >
  >
> {}
export const UpdateAsset = Binding.Service<UpdateAsset>(
  "AWS.DataExchange.UpdateAsset",
);
