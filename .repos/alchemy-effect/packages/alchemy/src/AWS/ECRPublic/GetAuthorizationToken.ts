import type * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ecr-public:GetAuthorizationToken` (plus the
 * `sts:GetServiceBearerToken` permission the API requires).
 *
 * Retrieves a registry authorization token (valid for 12 hours) used to
 * authenticate `docker push` against `public.ecr.aws`. The token in the
 * response is `Redacted` — unwrap it with `Redacted.value` at the point of
 * use. Provide the implementation with
 * `Effect.provide(AWS.ECRPublic.GetAuthorizationTokenHttp)`.
 *
 * @binding
 * @section Registry Access
 * @example Mint A Registry Auth Token
 * ```typescript
 * // init — registry-level binding takes no resource
 * const getAuthorizationToken = yield* AWS.ECRPublic.GetAuthorizationToken();
 *
 * // runtime
 * const result = yield* getAuthorizationToken();
 * const token = result.authorizationData?.authorizationToken; // Redacted<string>
 * ```
 */
export interface GetAuthorizationToken extends Binding.Service<
  GetAuthorizationToken,
  "AWS.ECRPublic.GetAuthorizationToken",
  () => Effect.Effect<
    () => Effect.Effect<
      ecrpublic.GetAuthorizationTokenResponse,
      ecrpublic.GetAuthorizationTokenError
    >
  >
> {}

export const GetAuthorizationToken = Binding.Service<GetAuthorizationToken>(
  "AWS.ECRPublic.GetAuthorizationToken",
);
