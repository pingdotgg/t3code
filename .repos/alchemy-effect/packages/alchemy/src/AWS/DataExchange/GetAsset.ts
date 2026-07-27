import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Revision } from "./Revision.ts";

/**
 * Runtime binding for `dataexchange:GetAsset`.
 *
 * Reads one asset of the bound revision — name, type-specific details
 * (S3 snapshot size, API Gateway endpoint, …), and timestamps. The data
 * set and revision ids are injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.GetAssetHttp)`.
 * @binding
 * @section Reading Revisions & Assets
 * @example Read An Asset's Detail
 * ```typescript
 * const getAsset = yield* AWS.DataExchange.GetAsset(revision);
 *
 * // runtime
 * const asset = yield* getAsset({ AssetId: assetId });
 * yield* Effect.log(`asset ${asset.Name}`);
 * ```
 */
export interface GetAsset extends Binding.Service<
  GetAsset,
  "AWS.DataExchange.GetAsset",
  (
    revision: Revision,
  ) => Effect.Effect<
    (
      request: Omit<dataexchange.GetAssetRequest, "DataSetId" | "RevisionId">,
    ) => Effect.Effect<
      dataexchange.GetAssetResponse,
      dataexchange.GetAssetError
    >
  >
> {}
export const GetAsset = Binding.Service<GetAsset>("AWS.DataExchange.GetAsset");
