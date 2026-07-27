import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link AcceptGrant}.
 */
export interface AcceptGrantRequest extends licensemanager.AcceptGrantRequest {}

/**
 * Runtime binding for `license-manager:AcceptGrant` — accept a license
 * grant that another account distributed to this account, activating the
 * granted entitlements.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.AcceptGrantHttp)`.
 * @binding
 * @section Managing Grants
 * @example Accept a Received Grant
 * ```typescript
 * // init
 * const acceptGrant = yield* AWS.LicenseManager.AcceptGrant();
 *
 * // runtime
 * const { Status } = yield* acceptGrant({ GrantArn: grantArn });
 * ```
 */
export interface AcceptGrant extends Binding.Service<
  AcceptGrant,
  "AWS.LicenseManager.AcceptGrant",
  () => Effect.Effect<
    (
      request: AcceptGrantRequest,
    ) => Effect.Effect<
      licensemanager.AcceptGrantResponse,
      licensemanager.AcceptGrantError
    >
  >
> {}
export const AcceptGrant = Binding.Service<AcceptGrant>(
  "AWS.LicenseManager.AcceptGrant",
);
