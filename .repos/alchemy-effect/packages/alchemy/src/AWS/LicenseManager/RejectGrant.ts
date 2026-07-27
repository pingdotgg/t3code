import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link RejectGrant}.
 */
export interface RejectGrantRequest extends licensemanager.RejectGrantRequest {}

/**
 * Runtime binding for `license-manager:RejectGrant` — reject a license
 * grant that another account distributed to this account.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.RejectGrantHttp)`.
 * @binding
 * @section Managing Grants
 * @example Reject a Received Grant
 * ```typescript
 * // init
 * const rejectGrant = yield* AWS.LicenseManager.RejectGrant();
 *
 * // runtime
 * const { Status } = yield* rejectGrant({ GrantArn: grantArn });
 * ```
 */
export interface RejectGrant extends Binding.Service<
  RejectGrant,
  "AWS.LicenseManager.RejectGrant",
  () => Effect.Effect<
    (
      request: RejectGrantRequest,
    ) => Effect.Effect<
      licensemanager.RejectGrantResponse,
      licensemanager.RejectGrantError
    >
  >
> {}
export const RejectGrant = Binding.Service<RejectGrant>(
  "AWS.LicenseManager.RejectGrant",
);
