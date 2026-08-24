import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link CheckInLicense}.
 */
export interface CheckInLicenseRequest
  extends licensemanager.CheckInLicenseRequest {}

/**
 * Runtime binding for `license-manager:CheckInLicense` — return a
 * previously checked-out entitlement to the license pool using the
 * consumption token from {@link CheckoutLicense}.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.CheckInLicenseHttp)`.
 * @binding
 * @section License Checkout Data Plane
 * @example Check an Entitlement Back In
 * ```typescript
 * // init
 * const checkInLicense = yield* AWS.LicenseManager.CheckInLicense();
 *
 * // runtime
 * yield* checkInLicense({ LicenseConsumptionToken: token });
 * ```
 */
export interface CheckInLicense extends Binding.Service<
  CheckInLicense,
  "AWS.LicenseManager.CheckInLicense",
  () => Effect.Effect<
    (
      request: CheckInLicenseRequest,
    ) => Effect.Effect<
      licensemanager.CheckInLicenseResponse,
      licensemanager.CheckInLicenseError
    >
  >
> {}
export const CheckInLicense = Binding.Service<CheckInLicense>(
  "AWS.LicenseManager.CheckInLicense",
);
