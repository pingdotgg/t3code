import type * as codeartifact from "@distilled.cloud/aws/codeartifact";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

/**
 * Request for {@link GetAuthorizationToken} — `domain` and `domainOwner` are
 * injected from the bound {@link Domain}.
 */
export interface GetAuthorizationTokenRequest {
  /**
   * How long the token remains valid. Between 15 minutes and 12 hours, or
   * exactly `0` to match the remaining duration of the caller's role session.
   * @default 12 hours
   */
  duration?: Duration.Input;
}

/**
 * Runtime binding for `codeartifact:GetAuthorizationToken`.
 *
 * Mints a temporary authorization token for the bound domain — the credential
 * package managers (npm, pip, maven, …) present to a CodeArtifact repository
 * endpoint. The deploy-time half grants `codeartifact:GetAuthorizationToken`
 * on the domain plus the `sts:GetServiceBearerToken` call CodeArtifact
 * performs on the caller's behalf. Provide the implementation with
 * `Effect.provide(AWS.CodeArtifact.GetAuthorizationTokenHttp)`.
 *
 * The returned `authorizationToken` is wrapped in `Redacted` so it never
 * leaks into logs — unwrap with `Redacted.value(...)` at the point of use.
 *
 * @binding
 * @section Authenticating Package Managers
 * @example Mint a Token for npm
 * ```typescript
 * import * as Redacted from "effect/Redacted";
 *
 * const getToken = yield* AWS.CodeArtifact.GetAuthorizationToken(domain);
 *
 * const res = yield* getToken({ duration: "1 hour" });
 * const token = Redacted.isRedacted(res.authorizationToken)
 *   ? Redacted.value(res.authorizationToken)
 *   : res.authorizationToken; // pass to `npm config set //…:_authToken=`
 * ```
 */
export interface GetAuthorizationToken extends Binding.Service<
  GetAuthorizationToken,
  "AWS.CodeArtifact.GetAuthorizationToken",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request?: GetAuthorizationTokenRequest,
    ) => Effect.Effect<
      codeartifact.GetAuthorizationTokenResult,
      codeartifact.GetAuthorizationTokenError
    >
  >
> {}

export const GetAuthorizationToken = Binding.Service<GetAuthorizationToken>(
  "AWS.CodeArtifact.GetAuthorizationToken",
);
