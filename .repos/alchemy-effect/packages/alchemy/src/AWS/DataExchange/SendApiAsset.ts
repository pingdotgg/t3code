import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSet } from "./DataSet.ts";

/**
 * Runtime binding for `dataexchange:SendApiAsset`.
 *
 * Invokes an API asset of an entitled `API_GATEWAY_API` data set — the
 * Data Exchange data plane proxies the request to the provider's API
 * Gateway. The data set id is injected from the binding; pass the
 * revision and asset ids of the API asset to call.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.SendApiAssetHttp)`.
 * @binding
 * @section Calling API Assets
 * @example Call A Subscribed API Asset
 * ```typescript
 * const sendApiAsset = yield* AWS.DataExchange.SendApiAsset(dataSet);
 *
 * // runtime
 * const response = yield* sendApiAsset({
 *   RevisionId: revisionId,
 *   AssetId: assetId,
 *   Method: "GET",
 *   Path: "/prices",
 * });
 * ```
 */
export interface SendApiAsset extends Binding.Service<
  SendApiAsset,
  "AWS.DataExchange.SendApiAsset",
  (
    dataSet: DataSet,
  ) => Effect.Effect<
    (
      request: Omit<dataexchange.SendApiAssetRequest, "DataSetId">,
    ) => Effect.Effect<
      dataexchange.SendApiAssetResponse,
      dataexchange.SendApiAssetError
    >
  >
> {}
export const SendApiAsset = Binding.Service<SendApiAsset>(
  "AWS.DataExchange.SendApiAsset",
);
