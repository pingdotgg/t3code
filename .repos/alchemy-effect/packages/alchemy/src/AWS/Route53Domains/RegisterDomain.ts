import type * as route53domains from "@distilled.cloud/aws/route-53-domains";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface RegisterDomainRequest
  extends route53domains.RegisterDomainRequest {}

/**
 * Runtime binding for `route53domains:RegisterDomain` — register a domain
 * name with Route 53 programmatically. Registration is asynchronous: the
 * response carries an `OperationId` you can poll with
 * `AWS.Route53Domains.GetOperationDetail`.
 *
 * Registering a domain **bills the AWS account** for the registration fee,
 * so guard calls carefully (e.g. behind a
 * `AWS.Route53Domains.CheckDomainAvailability` check and explicit user
 * consent in a domain-reseller flow).
 *
 * Route 53 Domains is a global registration API with no resource-level IAM:
 * the binding takes no arguments and grants the function
 * `route53domains:RegisterDomain` plus `route53:CreateHostedZone` (the API
 * pre-validates that the caller can create the hosted zone Route 53
 * auto-creates during registration) on `*`. Calls are pinned to
 * `us-east-1`, the only region that serves the Route 53 Domains API,
 * regardless of where the function runs.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Route53Domains.RegisterDomainHttp)`.
 *
 * @binding
 * @section Registering Domains
 * @example Register a Domain for a Customer
 * ```typescript
 * // init
 * const registerDomain = yield* AWS.Route53Domains.RegisterDomain();
 *
 * // runtime
 * const result = yield* registerDomain({
 *   DomainName: "example-customer-domain.com",
 *   DurationInYears: 1,
 *   AdminContact: contact,
 *   RegistrantContact: contact,
 *   TechContact: contact,
 *   AutoRenew: true,
 * });
 * // poll result.OperationId with GetOperationDetail until SUCCESSFUL
 * ```
 */
export interface RegisterDomain extends Binding.Service<
  RegisterDomain,
  "AWS.Route53Domains.RegisterDomain",
  () => Effect.Effect<
    (
      request: RegisterDomainRequest,
    ) => Effect.Effect<
      route53domains.RegisterDomainResponse,
      route53domains.RegisterDomainError
    >
  >
> {}
export const RegisterDomain = Binding.Service<RegisterDomain>(
  "AWS.Route53Domains.RegisterDomain",
);
