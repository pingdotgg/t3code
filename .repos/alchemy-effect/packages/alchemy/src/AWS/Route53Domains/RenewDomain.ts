import type * as route53domains from "@distilled.cloud/aws/route-53-domains";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface RenewDomainRequest extends route53domains.RenewDomainRequest {}

/**
 * Runtime binding for `route53domains:RenewDomain` — renew a domain
 * registered in the current AWS account for the specified number of years.
 * Renewal is asynchronous: the response carries an `OperationId` you can
 * poll with `AWS.Route53Domains.GetOperationDetail`.
 *
 * Renewing a domain **bills the AWS account** for the renewal fee, so guard
 * calls carefully. Renewing a domain that is not registered in the account
 * fails with a typed `DomainNotFound` error.
 *
 * Route 53 Domains is a global registration API with no resource-level IAM:
 * the binding takes no arguments and grants the function
 * `route53domains:RenewDomain` on `*`. Calls are pinned to `us-east-1`, the
 * only region that serves the Route 53 Domains API, regardless of where the
 * function runs.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Route53Domains.RenewDomainHttp)`.
 *
 * @binding
 * @section Renewing Domains
 * @example Renew a Domain for One More Year
 * ```typescript
 * // init
 * const renewDomain = yield* AWS.Route53Domains.RenewDomain();
 *
 * // runtime
 * const result = yield* renewDomain({
 *   DomainName: "example.com",
 *   DurationInYears: 1,
 *   CurrentExpiryYear: 2027,
 * });
 * // poll result.OperationId with GetOperationDetail until SUCCESSFUL
 * ```
 */
export interface RenewDomain extends Binding.Service<
  RenewDomain,
  "AWS.Route53Domains.RenewDomain",
  () => Effect.Effect<
    (
      request: RenewDomainRequest,
    ) => Effect.Effect<
      route53domains.RenewDomainResponse,
      route53domains.RenewDomainError
    >
  >
> {}
export const RenewDomain = Binding.Service<RenewDomain>(
  "AWS.Route53Domains.RenewDomain",
);
