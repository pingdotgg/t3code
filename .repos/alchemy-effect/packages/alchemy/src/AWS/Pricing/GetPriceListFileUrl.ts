import type * as pricing from "@distilled.cloud/aws/pricing";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetPriceListFileUrlRequest
  extends pricing.GetPriceListFileUrlRequest {}

/**
 * Runtime binding for `pricing:GetPriceListFileUrl` — resolve a presigned
 * download URL for one bulk Price List file.
 *
 * Takes a `PriceListArn` and `FileFormat` (`csv` or `json`) obtained from
 * `ListPriceLists` and returns the URL the full offer file can be fetched
 * from. The binding takes no arguments and grants the function
 * `pricing:GetPriceListFileUrl` (the action has no resource-level IAM).
 * Calls are pinned to `us-east-1`, the region that serves the Price List
 * API. Provide the implementation with
 * `Effect.provide(AWS.Pricing.GetPriceListFileUrlHttp)`.
 *
 * @binding
 * @section Downloading Price List Files
 * @example Resolve a Price List Download URL
 * ```typescript
 * // init
 * const listPriceLists = yield* AWS.Pricing.ListPriceLists();
 * const getPriceListFileUrl = yield* AWS.Pricing.GetPriceListFileUrl();
 *
 * // runtime
 * const lists = yield* listPriceLists({
 *   ServiceCode: "AmazonEC2",
 *   CurrencyCode: "USD",
 *   EffectiveDate: new Date(),
 *   RegionCode: "us-east-1",
 * });
 * const arn = lists.PriceLists?.[0]?.PriceListArn;
 * if (arn !== undefined) {
 *   const { Url } = yield* getPriceListFileUrl({
 *     PriceListArn: arn,
 *     FileFormat: "json",
 *   });
 * }
 * ```
 */
export interface GetPriceListFileUrl extends Binding.Service<
  GetPriceListFileUrl,
  "AWS.Pricing.GetPriceListFileUrl",
  () => Effect.Effect<
    (
      request: GetPriceListFileUrlRequest,
    ) => Effect.Effect<
      pricing.GetPriceListFileUrlResponse,
      pricing.GetPriceListFileUrlError
    >
  >
> {}
export const GetPriceListFileUrl = Binding.Service<GetPriceListFileUrl>(
  "AWS.Pricing.GetPriceListFileUrl",
);
