import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetGrant}.
 */
export interface GetGrantRequest extends licensemanager.GetGrantRequest {}

/**
 * Runtime binding for `license-manager:GetGrant` — read a license grant's
 * details (grantee, allowed operations, status) by ARN.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.GetGrantHttp)`.
 * @binding
 * @section Reading Licenses and Grants
 * @example Read a Grant
 * ```typescript
 * // init
 * const getGrant = yield* AWS.LicenseManager.GetGrant();
 *
 * // runtime
 * const { Grant } = yield* getGrant({ GrantArn: grantArn });
 * ```
 */
export interface GetGrant extends Binding.Service<
  GetGrant,
  "AWS.LicenseManager.GetGrant",
  () => Effect.Effect<
    (
      request: GetGrantRequest,
    ) => Effect.Effect<
      licensemanager.GetGrantResponse,
      licensemanager.GetGrantError
    >
  >
> {}
export const GetGrant = Binding.Service<GetGrant>(
  "AWS.LicenseManager.GetGrant",
);
