import type * as pricing from "@distilled.cloud/aws/pricing";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListPriceListsRequest extends pricing.ListPriceListsRequest {}

/**
 * Runtime binding for `pricing:ListPriceLists` — list the bulk Price List
 * file references available for a service, currency, and effective date.
 *
 * Each returned reference carries a `PriceListArn` and the `FileFormats`
 * it can be downloaded in (`csv`, `json`); pass the ARN and a format to
 * `GetPriceListFileUrl` to obtain a presigned download URL. Use without a
 * `RegionCode` to list Price Lists from every AWS Region, or with one to
 * narrow to a single Region. The binding takes no arguments and grants the
 * function `pricing:ListPriceLists` (the action has no resource-level
 * IAM). Calls are pinned to `us-east-1`, the region that serves the Price
 * List API. Provide the implementation with
 * `Effect.provide(AWS.Pricing.ListPriceListsHttp)`.
 *
 * @binding
 * @section Listing Price List Files
 * @example List EC2 Price Lists for us-east-1
 * ```typescript
 * // init
 * const listPriceLists = yield* AWS.Pricing.ListPriceLists();
 *
 * // runtime
 * const result = yield* listPriceLists({
 *   ServiceCode: "AmazonEC2",
 *   CurrencyCode: "USD",
 *   EffectiveDate: new Date(),
 *   RegionCode: "us-east-1",
 * });
 * const arns = (result.PriceLists ?? []).map((p) => p.PriceListArn);
 * ```
 */
export interface ListPriceLists extends Binding.Service<
  ListPriceLists,
  "AWS.Pricing.ListPriceLists",
  () => Effect.Effect<
    (
      request: ListPriceListsRequest,
    ) => Effect.Effect<
      pricing.ListPriceListsResponse,
      pricing.ListPriceListsError
    >
  >
> {}
export const ListPriceLists = Binding.Service<ListPriceLists>(
  "AWS.Pricing.ListPriceLists",
);
