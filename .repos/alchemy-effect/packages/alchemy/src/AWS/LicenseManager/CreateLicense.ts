import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link CreateLicense}.
 */
export interface CreateLicenseRequest
  extends licensemanager.CreateLicenseRequest {}

/**
 * Runtime binding for `license-manager:CreateLicense` — issue a
 * seller-issued license from the calling application. The core of an ISV
 * ordering/fulfillment backend: when a customer purchases, the backend
 * mints a license with the product SKU, entitlements, validity window,
 * and consumption configuration, then distributes it via grants or
 * activation tokens.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.CreateLicenseHttp)`.
 * @binding
 * @section Issuing Licenses
 * @example Issue a License on Purchase
 * ```typescript
 * // init — account-level binding takes no resource
 * const createLicense = yield* AWS.LicenseManager.CreateLicense();
 *
 * // runtime
 * const { LicenseArn, Version } = yield* createLicense({
 *   LicenseName: "my-product-license",
 *   ProductName: "My Product",
 *   ProductSKU: "my-product-sku",
 *   Issuer: { Name: "my-company" },
 *   HomeRegion: region,
 *   Validity: { Begin: new Date().toISOString() },
 *   Entitlements: [
 *     { Name: "seats", MaxCount: 10, Unit: "Count", AllowCheckIn: true },
 *   ],
 *   Beneficiary: customerAccountId,
 *   ConsumptionConfiguration: {
 *     ProvisionalConfiguration: { MaxTimeToLiveInMinutes: 60 },
 *   },
 *   ClientToken: crypto.randomUUID(),
 * });
 * ```
 */
export interface CreateLicense extends Binding.Service<
  CreateLicense,
  "AWS.LicenseManager.CreateLicense",
  () => Effect.Effect<
    (
      request: CreateLicenseRequest,
    ) => Effect.Effect<
      licensemanager.CreateLicenseResponse,
      licensemanager.CreateLicenseError
    >
  >
> {}
export const CreateLicense = Binding.Service<CreateLicense>(
  "AWS.LicenseManager.CreateLicense",
);
