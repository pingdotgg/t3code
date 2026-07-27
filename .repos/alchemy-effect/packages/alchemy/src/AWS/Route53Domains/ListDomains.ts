import type * as route53domains from "@distilled.cloud/aws/route-53-domains";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListDomainsRequest extends route53domains.ListDomainsRequest {}

/**
 * Runtime binding for `route53domains:ListDomains` — list all domain names
 * registered with Route 53 for the current AWS account.
 *
 * Route 53 Domains is a global registration API with no resource-level IAM:
 * the binding takes no arguments and grants the function
 * `route53domains:ListDomains` on `*`. Calls are pinned to `us-east-1`, the
 * only region that serves the Route 53 Domains API, regardless of where the
 * function runs.
 *
 * Pass `Marker` from a previous response's `NextPageMarker` to paginate.
 * Provide the implementation with
 * `Effect.provide(AWS.Route53Domains.ListDomainsHttp)`.
 *
 * @binding
 * @section Listing Registered Domains
 * @example List the Account's Domains
 * ```typescript
 * // init
 * const listDomains = yield* AWS.Route53Domains.ListDomains();
 *
 * // runtime
 * const result = yield* listDomains({ MaxItems: 100 });
 * const names = (result.Domains ?? []).map((domain) => domain.DomainName);
 * ```
 */
export interface ListDomains extends Binding.Service<
  ListDomains,
  "AWS.Route53Domains.ListDomains",
  () => Effect.Effect<
    (
      request: ListDomainsRequest,
    ) => Effect.Effect<
      route53domains.ListDomainsResponse,
      route53domains.ListDomainsError
    >
  >
> {}
export const ListDomains = Binding.Service<ListDomains>(
  "AWS.Route53Domains.ListDomains",
);
