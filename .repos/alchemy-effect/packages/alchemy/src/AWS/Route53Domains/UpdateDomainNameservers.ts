import type * as route53domains from "@distilled.cloud/aws/route-53-domains";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface UpdateDomainNameserversRequest
  extends route53domains.UpdateDomainNameserversRequest {}

/**
 * Runtime binding for `route53domains:UpdateDomainNameservers` — replace
 * the nameservers for a domain registered in the current AWS account (e.g.
 * point a registered domain at the delegation set of a Route 53 hosted
 * zone). The update is asynchronous: the response carries an `OperationId`
 * you can poll with `AWS.Route53Domains.GetOperationDetail`.
 *
 * Updating nameservers for a domain that is not registered in the account
 * fails with a typed `DomainNotFound` error.
 *
 * Route 53 Domains is a global registration API with no resource-level IAM:
 * the binding takes no arguments and grants the function
 * `route53domains:UpdateDomainNameservers` on `*`. Calls are pinned to
 * `us-east-1`, the only region that serves the Route 53 Domains API,
 * regardless of where the function runs.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Route53Domains.UpdateDomainNameserversHttp)`.
 *
 * @binding
 * @section Updating Nameservers
 * @example Point a Domain at a Hosted Zone's Delegation Set
 * ```typescript
 * // init
 * const updateDomainNameservers =
 *   yield* AWS.Route53Domains.UpdateDomainNameservers();
 *
 * // runtime
 * const result = yield* updateDomainNameservers({
 *   DomainName: "example.com",
 *   Nameservers: [
 *     { Name: "ns-1.awsdns-01.org" },
 *     { Name: "ns-2.awsdns-02.com" },
 *   ],
 * });
 * // poll result.OperationId with GetOperationDetail until SUCCESSFUL
 * ```
 */
export interface UpdateDomainNameservers extends Binding.Service<
  UpdateDomainNameservers,
  "AWS.Route53Domains.UpdateDomainNameservers",
  () => Effect.Effect<
    (
      request: UpdateDomainNameserversRequest,
    ) => Effect.Effect<
      route53domains.UpdateDomainNameserversResponse,
      route53domains.UpdateDomainNameserversError
    >
  >
> {}
export const UpdateDomainNameservers = Binding.Service<UpdateDomainNameservers>(
  "AWS.Route53Domains.UpdateDomainNameservers",
);
