import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListTokens}.
 */
export interface ListTokensRequest extends licensemanager.ListTokensRequest {}

/**
 * Runtime binding for `license-manager:ListTokens` — enumerate the refresh
 * tokens minted for the account's licenses (token metadata only; the token
 * material itself is returned once by `CreateToken`).
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.ListTokensHttp)`.
 * @binding
 * @section License Checkout Data Plane
 * @example List Activation Tokens
 * ```typescript
 * // init
 * const listTokens = yield* AWS.LicenseManager.ListTokens();
 *
 * // runtime
 * const { Tokens } = yield* listTokens();
 * ```
 */
export interface ListTokens extends Binding.Service<
  ListTokens,
  "AWS.LicenseManager.ListTokens",
  () => Effect.Effect<
    (
      request?: ListTokensRequest,
    ) => Effect.Effect<
      licensemanager.ListTokensResponse,
      licensemanager.ListTokensError
    >
  >
> {}
export const ListTokens = Binding.Service<ListTokens>(
  "AWS.LicenseManager.ListTokens",
);
