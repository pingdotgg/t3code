import type * as route53domains from "@distilled.cloud/aws/route-53-domains";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface RetrieveDomainAuthCodeRequest
  extends route53domains.RetrieveDomainAuthCodeRequest {}

/**
 * Runtime binding for `route53domains:RetrieveDomainAuthCode` — retrieve
 * the authorization (transfer) code for a domain registered in the current
 * AWS account. The code is required to transfer the domain to another
 * registrar.
 *
 * The returned `AuthCode` is a secret and is typed as
 * `Redacted.Redacted<string>` — unwrap with `Redacted.value` only at the
 * point of use. Requesting the code for a domain that is not registered in
 * the account fails with a typed `DomainNotFound` error.
 *
 * Route 53 Domains is a global registration API with no resource-level IAM:
 * the binding takes no arguments and grants the function
 * `route53domains:RetrieveDomainAuthCode` on `*`. Calls are pinned to
 * `us-east-1`, the only region that serves the Route 53 Domains API,
 * regardless of where the function runs.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Route53Domains.RetrieveDomainAuthCodeHttp)`.
 *
 * @binding
 * @section Transferring Domains Out
 * @example Retrieve the Transfer Authorization Code
 * ```typescript
 * import * as Redacted from "effect/Redacted";
 *
 * // init
 * const retrieveDomainAuthCode =
 *   yield* AWS.Route53Domains.RetrieveDomainAuthCode();
 *
 * // runtime
 * const result = yield* retrieveDomainAuthCode({ DomainName: "example.com" });
 * const authCode =
 *   result.AuthCode !== undefined && typeof result.AuthCode !== "string"
 *     ? Redacted.value(result.AuthCode)
 *     : result.AuthCode;
 * ```
 */
export interface RetrieveDomainAuthCode extends Binding.Service<
  RetrieveDomainAuthCode,
  "AWS.Route53Domains.RetrieveDomainAuthCode",
  () => Effect.Effect<
    (
      request: RetrieveDomainAuthCodeRequest,
    ) => Effect.Effect<
      route53domains.RetrieveDomainAuthCodeResponse,
      route53domains.RetrieveDomainAuthCodeError
    >
  >
> {}
export const RetrieveDomainAuthCode = Binding.Service<RetrieveDomainAuthCode>(
  "AWS.Route53Domains.RetrieveDomainAuthCode",
);
