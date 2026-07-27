import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LicenseConfiguration } from "./LicenseConfiguration.ts";

/**
 * Runtime binding for `license-manager:GetLicenseConfiguration` — read the
 * bound license configuration's live state (counting type, license count,
 * consumed count, rules, status) from a deployed Lambda or Task.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.GetLicenseConfigurationHttp)`.
 * @binding
 * @section Reading License Configurations
 * @example Read the Bound Configuration's Consumption
 * ```typescript
 * // init
 * const getConfiguration =
 *   yield* AWS.LicenseManager.GetLicenseConfiguration(licenses);
 *
 * // runtime
 * const config = yield* getConfiguration();
 * const remaining =
 *   (config.LicenseCount ?? 0) - (config.ConsumedLicenses ?? 0);
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.LicenseManager.GetLicenseConfigurationHttp))
 * ```
 */
export interface GetLicenseConfiguration extends Binding.Service<
  GetLicenseConfiguration,
  "AWS.LicenseManager.GetLicenseConfiguration",
  (
    configuration: LicenseConfiguration,
  ) => Effect.Effect<
    () => Effect.Effect<
      licensemanager.GetLicenseConfigurationResponse,
      licensemanager.GetLicenseConfigurationError
    >
  >
> {}
export const GetLicenseConfiguration = Binding.Service<GetLicenseConfiguration>(
  "AWS.LicenseManager.GetLicenseConfiguration",
);
