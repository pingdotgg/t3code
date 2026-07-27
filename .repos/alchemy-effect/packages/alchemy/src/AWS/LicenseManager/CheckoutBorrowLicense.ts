import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link CheckoutBorrowLicense}.
 */
export interface CheckoutBorrowLicenseRequest
  extends licensemanager.CheckoutBorrowLicenseRequest {}

/**
 * Runtime binding for `license-manager:CheckoutBorrowLicense` — check out
 * an offline-capable (borrow) entitlement from a seller-issued license
 * that allows borrowing. The signed token proves the entitlement while the
 * consumer is disconnected.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.CheckoutBorrowLicenseHttp)`.
 * @binding
 * @section License Checkout Data Plane
 * @example Borrow an Entitlement for Offline Use
 * ```typescript
 * // init
 * const checkoutBorrow = yield* AWS.LicenseManager.CheckoutBorrowLicense();
 *
 * // runtime
 * const borrowed = yield* checkoutBorrow({
 *   LicenseArn: licenseArn,
 *   Entitlements: [{ Name: "seats", Value: "1", Unit: "Count" }],
 *   DigitalSignatureMethod: "JWT_PS384",
 *   ClientToken: crypto.randomUUID(),
 * });
 * ```
 */
export interface CheckoutBorrowLicense extends Binding.Service<
  CheckoutBorrowLicense,
  "AWS.LicenseManager.CheckoutBorrowLicense",
  () => Effect.Effect<
    (
      request: CheckoutBorrowLicenseRequest,
    ) => Effect.Effect<
      licensemanager.CheckoutBorrowLicenseResponse,
      licensemanager.CheckoutBorrowLicenseError
    >
  >
> {}
export const CheckoutBorrowLicense = Binding.Service<CheckoutBorrowLicense>(
  "AWS.LicenseManager.CheckoutBorrowLicense",
);
