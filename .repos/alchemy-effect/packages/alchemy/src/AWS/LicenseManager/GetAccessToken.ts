import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetAccessToken}.
 */
export interface GetAccessTokenRequest
  extends licensemanager.GetAccessTokenRequest {}

/**
 * Runtime binding for `license-manager:GetAccessToken` — exchange a
 * long-lived refresh token (minted by `CreateToken`) for a temporary
 * access token to use with `AssumeRoleWithWebIdentity`. Both the refresh
 * token and the returned access token are `Redacted` end-to-end.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.GetAccessTokenHttp)`.
 * @binding
 * @section License Checkout Data Plane
 * @example Exchange a Refresh Token for an Access Token
 * ```typescript
 * // init
 * const getAccessToken = yield* AWS.LicenseManager.GetAccessToken();
 *
 * // runtime — AccessToken is Redacted; unwrap only at the point of use
 * const { AccessToken } = yield* getAccessToken({ Token: refreshToken });
 * ```
 */
export interface GetAccessToken extends Binding.Service<
  GetAccessToken,
  "AWS.LicenseManager.GetAccessToken",
  () => Effect.Effect<
    (
      request: GetAccessTokenRequest,
    ) => Effect.Effect<
      licensemanager.GetAccessTokenResponse,
      licensemanager.GetAccessTokenError
    >
  >
> {}
export const GetAccessToken = Binding.Service<GetAccessToken>(
  "AWS.LicenseManager.GetAccessToken",
);
