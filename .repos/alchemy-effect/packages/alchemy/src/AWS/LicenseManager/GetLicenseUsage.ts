import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetLicenseUsage}.
 */
export interface GetLicenseUsageRequest
  extends licensemanager.GetLicenseUsageRequest {}

/**
 * Runtime binding for `license-manager:GetLicenseUsage` — read the
 * per-entitlement usage counters of a seller-issued license.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.GetLicenseUsageHttp)`.
 * @binding
 * @section Reading Licenses and Grants
 * @example Read a License's Entitlement Usage
 * ```typescript
 * // init
 * const getLicenseUsage = yield* AWS.LicenseManager.GetLicenseUsage();
 *
 * // runtime
 * const { LicenseUsage } = yield* getLicenseUsage({
 *   LicenseArn: licenseArn,
 * });
 * ```
 */
export interface GetLicenseUsage extends Binding.Service<
  GetLicenseUsage,
  "AWS.LicenseManager.GetLicenseUsage",
  () => Effect.Effect<
    (
      request: GetLicenseUsageRequest,
    ) => Effect.Effect<
      licensemanager.GetLicenseUsageResponse,
      licensemanager.GetLicenseUsageError
    >
  >
> {}
export const GetLicenseUsage = Binding.Service<GetLicenseUsage>(
  "AWS.LicenseManager.GetLicenseUsage",
);
