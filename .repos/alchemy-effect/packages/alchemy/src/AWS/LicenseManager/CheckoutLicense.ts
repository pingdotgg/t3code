import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link CheckoutLicense}.
 */
export interface CheckoutLicenseRequest
  extends licensemanager.CheckoutLicenseRequest {}

/**
 * Runtime binding for `license-manager:CheckoutLicense` — check out
 * entitlements from a seller-issued license for the calling application.
 * The returned `LicenseConsumptionToken` is used to check in or extend the
 * consumption; `PROVISIONAL` checkouts expire and must be extended with
 * {@link ExtendLicenseConsumption}.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.CheckoutLicenseHttp)`.
 * @binding
 * @section License Checkout Data Plane
 * @example Check Out an Entitlement
 * ```typescript
 * // init — account-level binding takes no resource
 * const checkoutLicense = yield* AWS.LicenseManager.CheckoutLicense();
 *
 * // runtime
 * const checkout = yield* checkoutLicense({
 *   ProductSKU: "my-product-sku",
 *   CheckoutType: "PROVISIONAL",
 *   KeyFingerprint: keyFingerprint,
 *   Entitlements: [{ Name: "seats", Value: "1", Unit: "Count" }],
 *   ClientToken: crypto.randomUUID(),
 * });
 * const token = checkout.LicenseConsumptionToken;
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.LicenseManager.CheckoutLicenseHttp))
 * ```
 */
export interface CheckoutLicense extends Binding.Service<
  CheckoutLicense,
  "AWS.LicenseManager.CheckoutLicense",
  () => Effect.Effect<
    (
      request: CheckoutLicenseRequest,
    ) => Effect.Effect<
      licensemanager.CheckoutLicenseResponse,
      licensemanager.CheckoutLicenseError
    >
  >
> {}
export const CheckoutLicense = Binding.Service<CheckoutLicense>(
  "AWS.LicenseManager.CheckoutLicense",
);
