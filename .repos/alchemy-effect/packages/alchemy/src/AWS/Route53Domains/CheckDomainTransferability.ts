import type * as route53domains from "@distilled.cloud/aws/route-53-domains";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface CheckDomainTransferabilityRequest
  extends route53domains.CheckDomainTransferabilityRequest {}

/**
 * Runtime binding for `route53domains:CheckDomainTransferability` — check
 * whether a domain can be transferred to Amazon Route 53 from another
 * registrar.
 *
 * Route 53 Domains is a global registration API with no resource-level IAM:
 * the binding takes no arguments and grants the function
 * `route53domains:CheckDomainTransferability` on `*`. Calls are pinned to
 * `us-east-1`, the only region that serves the Route 53 Domains API,
 * regardless of where the function runs.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Route53Domains.CheckDomainTransferabilityHttp)`.
 *
 * @binding
 * @section Checking Domain Transferability
 * @example Check Whether a Domain Can Be Transferred In
 * ```typescript
 * // init
 * const checkDomainTransferability =
 *   yield* AWS.Route53Domains.CheckDomainTransferability();
 *
 * // runtime
 * const result = yield* checkDomainTransferability({
 *   DomainName: "example.com",
 * });
 * if (result.Transferability?.Transferable === "TRANSFERABLE") {
 *   // domain can be transferred to Route 53
 * }
 * ```
 */
export interface CheckDomainTransferability extends Binding.Service<
  CheckDomainTransferability,
  "AWS.Route53Domains.CheckDomainTransferability",
  () => Effect.Effect<
    (
      request: CheckDomainTransferabilityRequest,
    ) => Effect.Effect<
      route53domains.CheckDomainTransferabilityResponse,
      route53domains.CheckDomainTransferabilityError
    >
  >
> {}
export const CheckDomainTransferability =
  Binding.Service<CheckDomainTransferability>(
    "AWS.Route53Domains.CheckDomainTransferability",
  );
