import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ExtendLicenseConsumption}.
 */
export interface ExtendLicenseConsumptionRequest
  extends licensemanager.ExtendLicenseConsumptionRequest {}

/**
 * Runtime binding for `license-manager:ExtendLicenseConsumption` — extend
 * a `PROVISIONAL` checkout's expiration before it lapses, keeping a
 * long-running consumer's entitlement active.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.ExtendLicenseConsumptionHttp)`.
 * @binding
 * @section License Checkout Data Plane
 * @example Extend a Provisional Checkout
 * ```typescript
 * // init
 * const extendConsumption =
 *   yield* AWS.LicenseManager.ExtendLicenseConsumption();
 *
 * // runtime
 * const { Expiration } = yield* extendConsumption({
 *   LicenseConsumptionToken: token,
 * });
 * ```
 */
export interface ExtendLicenseConsumption extends Binding.Service<
  ExtendLicenseConsumption,
  "AWS.LicenseManager.ExtendLicenseConsumption",
  () => Effect.Effect<
    (
      request: ExtendLicenseConsumptionRequest,
    ) => Effect.Effect<
      licensemanager.ExtendLicenseConsumptionResponse,
      licensemanager.ExtendLicenseConsumptionError
    >
  >
> {}
export const ExtendLicenseConsumption =
  Binding.Service<ExtendLicenseConsumption>(
    "AWS.LicenseManager.ExtendLicenseConsumption",
  );
