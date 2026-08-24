import type * as route53domains from "@distilled.cloud/aws/route-53-domains";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetDomainDetailRequest
  extends route53domains.GetDomainDetailRequest {}

/**
 * Runtime binding for `route53domains:GetDomainDetail` — return detailed
 * information (nameservers, contacts, expiry, DNSSEC keys, status list)
 * about a domain registered with the current AWS account.
 *
 * Route 53 Domains is a global registration API with no resource-level IAM:
 * the binding takes no arguments and grants the function
 * `route53domains:GetDomainDetail` on `*`. Calls are pinned to `us-east-1`,
 * the only region that serves the Route 53 Domains API, regardless of where
 * the function runs.
 *
 * Requesting detail for a domain that is not registered in the current
 * account fails with a typed `DomainNotFound` error. Provide the
 * implementation with
 * `Effect.provide(AWS.Route53Domains.GetDomainDetailHttp)`.
 *
 * @binding
 * @section Reading Domain Details
 * @example Get the Nameservers of an Owned Domain
 * ```typescript
 * // init
 * const getDomainDetail = yield* AWS.Route53Domains.GetDomainDetail();
 *
 * // runtime
 * const detail = yield* getDomainDetail({ DomainName: "example.com" });
 * const nameservers = (detail.Nameservers ?? []).map((ns) => ns.Name);
 * ```
 *
 * @example Handle a Domain That Is Not in the Account
 * ```typescript
 * const detail = yield* getDomainDetail({ DomainName: "example.com" }).pipe(
 *   Effect.catchTag("DomainNotFound", () => Effect.succeed(undefined)),
 * );
 * ```
 */
export interface GetDomainDetail extends Binding.Service<
  GetDomainDetail,
  "AWS.Route53Domains.GetDomainDetail",
  () => Effect.Effect<
    (
      request: GetDomainDetailRequest,
    ) => Effect.Effect<
      route53domains.GetDomainDetailResponse,
      route53domains.GetDomainDetailError
    >
  >
> {}
export const GetDomainDetail = Binding.Service<GetDomainDetail>(
  "AWS.Route53Domains.GetDomainDetail",
);
