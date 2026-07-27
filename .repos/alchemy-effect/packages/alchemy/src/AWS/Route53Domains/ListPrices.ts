import type * as route53domains from "@distilled.cloud/aws/route-53-domains";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListPricesRequest extends route53domains.ListPricesRequest {}

/**
 * Runtime binding for `route53domains:ListPrices` — list registration,
 * transfer, renewal, restoration, and owner-change prices for the TLDs
 * supported by Route 53, or for one specific TLD.
 *
 * Route 53 Domains is a global registration API with no resource-level IAM:
 * the binding takes no arguments and grants the function
 * `route53domains:ListPrices` on `*`. Calls are pinned to `us-east-1`, the
 * only region that serves the Route 53 Domains API, regardless of where the
 * function runs.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Route53Domains.ListPricesHttp)`.
 *
 * @binding
 * @section Looking Up Prices
 * @example Get the Registration Price for .com
 * ```typescript
 * // init
 * const listPrices = yield* AWS.Route53Domains.ListPrices();
 *
 * // runtime
 * const result = yield* listPrices({ Tld: "com" });
 * const price = result.Prices?.[0]?.RegistrationPrice?.Price;
 * ```
 */
export interface ListPrices extends Binding.Service<
  ListPrices,
  "AWS.Route53Domains.ListPrices",
  () => Effect.Effect<
    (
      request: ListPricesRequest,
    ) => Effect.Effect<
      route53domains.ListPricesResponse,
      route53domains.ListPricesError
    >
  >
> {}
export const ListPrices = Binding.Service<ListPrices>(
  "AWS.Route53Domains.ListPrices",
);
