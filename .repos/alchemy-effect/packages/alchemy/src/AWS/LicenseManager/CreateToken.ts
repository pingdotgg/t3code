import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link CreateToken}.
 */
export interface CreateTokenRequest extends licensemanager.CreateTokenRequest {}

/**
 * Runtime binding for `license-manager:CreateToken` — mint a long-lived
 * refresh token for a license. The token (a claims-based JWT, `Redacted`
 * end-to-end) is distributed to license consumers, who exchange it for
 * temporary credentials with `GetAccessToken` +
 * `AssumeRoleWithWebIdentity`.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.CreateTokenHttp)`.
 * @binding
 * @section License Checkout Data Plane
 * @example Mint an Activation Token for a License
 * ```typescript
 * // init
 * const createToken = yield* AWS.LicenseManager.CreateToken();
 *
 * // runtime — Token is Redacted; hand it to the consumer without logging it
 * const { TokenId, Token } = yield* createToken({
 *   LicenseArn: licenseArn,
 *   ClientToken: crypto.randomUUID(),
 * });
 * ```
 */
export interface CreateToken extends Binding.Service<
  CreateToken,
  "AWS.LicenseManager.CreateToken",
  () => Effect.Effect<
    (
      request: CreateTokenRequest,
    ) => Effect.Effect<
      licensemanager.CreateTokenResponse,
      licensemanager.CreateTokenError
    >
  >
> {}
export const CreateToken = Binding.Service<CreateToken>(
  "AWS.LicenseManager.CreateToken",
);
