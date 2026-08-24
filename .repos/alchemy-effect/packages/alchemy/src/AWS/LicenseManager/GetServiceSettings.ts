import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetServiceSettings}.
 */
export interface GetServiceSettingsRequest
  extends licensemanager.GetServiceSettingsRequest {}

/**
 * Runtime binding for `license-manager:GetServiceSettings` — read the
 * account's License Manager settings (S3 report bucket, SNS alert topic,
 * organization integration).
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.GetServiceSettingsHttp)`.
 * @binding
 * @section Resource Inventory and Specifications
 * @example Read the Account's Service Settings
 * ```typescript
 * // init
 * const getServiceSettings =
 *   yield* AWS.LicenseManager.GetServiceSettings();
 *
 * // runtime
 * const { SnsTopicArn, EnableCrossAccountsDiscovery } =
 *   yield* getServiceSettings();
 * ```
 */
export interface GetServiceSettings extends Binding.Service<
  GetServiceSettings,
  "AWS.LicenseManager.GetServiceSettings",
  () => Effect.Effect<
    (
      request?: GetServiceSettingsRequest,
    ) => Effect.Effect<
      licensemanager.GetServiceSettingsResponse,
      licensemanager.GetServiceSettingsError
    >
  >
> {}
export const GetServiceSettings = Binding.Service<GetServiceSettings>(
  "AWS.LicenseManager.GetServiceSettings",
);
