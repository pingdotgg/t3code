import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetLicense}.
 */
export interface GetLicenseRequest extends licensemanager.GetLicenseRequest {}

/**
 * Runtime binding for `license-manager:GetLicense` — read a seller-issued
 * license's details (issuer, entitlements, validity, consumption
 * configuration) by ARN.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.GetLicenseHttp)`.
 * @binding
 * @section Reading Licenses and Grants
 * @example Read a License
 * ```typescript
 * // init
 * const getLicense = yield* AWS.LicenseManager.GetLicense();
 *
 * // runtime
 * const { License } = yield* getLicense({ LicenseArn: licenseArn });
 * ```
 */
export interface GetLicense extends Binding.Service<
  GetLicense,
  "AWS.LicenseManager.GetLicense",
  () => Effect.Effect<
    (
      request: GetLicenseRequest,
    ) => Effect.Effect<
      licensemanager.GetLicenseResponse,
      licensemanager.GetLicenseError
    >
  >
> {}
export const GetLicense = Binding.Service<GetLicense>(
  "AWS.LicenseManager.GetLicense",
);
