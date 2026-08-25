import type * as serverless from "@distilled.cloud/aws/redshift-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `GetIdentityCenterAuthToken` operation (IAM actions
 * `redshift-serverless:GetIdentityCenterAuthToken`).
 *
 * Mints an IAM Identity Center authentication token for up to 20
 * workgroups — the trusted-identity-propagation alternative to
 * {@link Connect}'s `GetCredentials` flow. The response `token` decodes to
 * `Redacted<string>`. Provide the implementation with
 * `Effect.provide(AWS.RedshiftServerless.GetIdentityCenterAuthTokenHttp)`.
 * @binding
 * @section Connecting to a Workgroup
 * @example Mint an Identity Center Token
 * ```typescript
 * // init — resolve the runtime client
 * const getToken = yield* AWS.RedshiftServerless.GetIdentityCenterAuthToken();
 *
 * const { token, expirationTime } = yield* getToken({
 *   workgroupNames: [workgroupName],
 * });
 * ```
 */
export interface GetIdentityCenterAuthToken extends Binding.Service<
  GetIdentityCenterAuthToken,
  "AWS.RedshiftServerless.GetIdentityCenterAuthToken",
  () => Effect.Effect<
    (
      request: serverless.GetIdentityCenterAuthTokenRequest,
    ) => Effect.Effect<
      serverless.GetIdentityCenterAuthTokenResponse,
      serverless.GetIdentityCenterAuthTokenError
    >
  >
> {}
export const GetIdentityCenterAuthToken =
  Binding.Service<GetIdentityCenterAuthToken>(
    "AWS.RedshiftServerless.GetIdentityCenterAuthToken",
  );
