import type * as route53domains from "@distilled.cloud/aws/route-53-domains";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface CheckDomainAvailabilityRequest
  extends route53domains.CheckDomainAvailabilityRequest {}

/**
 * Runtime binding for `route53domains:CheckDomainAvailability` — check
 * whether a domain name is available for registration with Route 53.
 *
 * Route 53 Domains is a global registration API with no resource-level IAM:
 * the binding takes no arguments and grants the function
 * `route53domains:CheckDomainAvailability` on `*`. Calls are pinned to
 * `us-east-1`, the only region that serves the Route 53 Domains API,
 * regardless of where the function runs.
 *
 * Note that if the returned `Availability` is `PENDING` you must submit
 * another request to determine the availability of the domain name.
 * Provide the implementation with
 * `Effect.provide(AWS.Route53Domains.CheckDomainAvailabilityHttp)`.
 *
 * @binding
 * @section Checking Domain Availability
 * @example Check Whether a Domain Can Be Registered
 * ```typescript
 * // init
 * const checkDomainAvailability =
 *   yield* AWS.Route53Domains.CheckDomainAvailability();
 *
 * // runtime
 * const result = yield* checkDomainAvailability({
 *   DomainName: "example-startup-name.com",
 * });
 * if (result.Availability === "AVAILABLE") {
 *   // domain can be registered
 * }
 * ```
 */
export interface CheckDomainAvailability extends Binding.Service<
  CheckDomainAvailability,
  "AWS.Route53Domains.CheckDomainAvailability",
  () => Effect.Effect<
    (
      request: CheckDomainAvailabilityRequest,
    ) => Effect.Effect<
      route53domains.CheckDomainAvailabilityResponse,
      route53domains.CheckDomainAvailabilityError
    >
  >
> {}
export const CheckDomainAvailability = Binding.Service<CheckDomainAvailability>(
  "AWS.Route53Domains.CheckDomainAvailability",
);
