import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link DeleteToken}.
 */
export interface DeleteTokenRequest extends licensemanager.DeleteTokenRequest {}

/**
 * Runtime binding for `license-manager:DeleteToken` — revoke a refresh
 * token minted by `CreateToken`, cutting off further `GetAccessToken`
 * exchanges for it.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.DeleteTokenHttp)`.
 * @binding
 * @section License Checkout Data Plane
 * @example Revoke an Activation Token
 * ```typescript
 * // init
 * const deleteToken = yield* AWS.LicenseManager.DeleteToken();
 *
 * // runtime
 * yield* deleteToken({ TokenId: tokenId });
 * ```
 */
export interface DeleteToken extends Binding.Service<
  DeleteToken,
  "AWS.LicenseManager.DeleteToken",
  () => Effect.Effect<
    (
      request: DeleteTokenRequest,
    ) => Effect.Effect<
      licensemanager.DeleteTokenResponse,
      licensemanager.DeleteTokenError
    >
  >
> {}
export const DeleteToken = Binding.Service<DeleteToken>(
  "AWS.LicenseManager.DeleteToken",
);
