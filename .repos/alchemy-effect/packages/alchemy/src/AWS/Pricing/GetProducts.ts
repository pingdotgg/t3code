import type * as pricing from "@distilled.cloud/aws/pricing";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetProductsRequest extends pricing.GetProductsRequest {}

/**
 * Runtime binding for `pricing:GetProducts` — query the AWS Price List API
 * for all products that match the filter criteria.
 *
 * The Price List Query API is a global, data-only service with no resource
 * to manage: the binding takes no arguments and grants the function
 * `pricing:GetProducts` (the action has no resource-level IAM). Calls are
 * pinned to `us-east-1`, the region that serves the Price List API,
 * regardless of where the function runs. Each `PriceList` entry is a JSON
 * string describing one product and its terms. Provide the implementation
 * with `Effect.provide(AWS.Pricing.GetProductsHttp)`.
 *
 * @binding
 * @section Querying Products
 * @example Look Up EC2 On-Demand Pricing
 * ```typescript
 * // init
 * const getProducts = yield* AWS.Pricing.GetProducts();
 *
 * // runtime
 * const result = yield* getProducts({
 *   ServiceCode: "AmazonEC2",
 *   Filters: [
 *     { Type: "TERM_MATCH", Field: "instanceType", Value: "t3.micro" },
 *     { Type: "TERM_MATCH", Field: "location", Value: "US East (N. Virginia)" },
 *     { Type: "TERM_MATCH", Field: "operatingSystem", Value: "Linux" },
 *   ],
 *   MaxResults: 10,
 * });
 * const products = (result.PriceList ?? []).map((item) => JSON.parse(item));
 * ```
 */
export interface GetProducts extends Binding.Service<
  GetProducts,
  "AWS.Pricing.GetProducts",
  () => Effect.Effect<
    (
      request: GetProductsRequest,
    ) => Effect.Effect<pricing.GetProductsResponse, pricing.GetProductsError>
  >
> {}
export const GetProducts = Binding.Service<GetProducts>(
  "AWS.Pricing.GetProducts",
);
