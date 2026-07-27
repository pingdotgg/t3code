import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LicenseConfiguration } from "./LicenseConfiguration.ts";

/**
 * Request for {@link ListUsageForLicenseConfiguration}. The bound configuration's ARN is injected
 * automatically.
 */
export interface ListUsageForLicenseConfigurationRequest extends Omit<
  licensemanager.ListUsageForLicenseConfigurationRequest,
  "LicenseConfigurationArn"
> {}

/**
 * Runtime binding for `license-manager:ListUsageForLicenseConfiguration` —
 * list per-resource license usage (consumed licenses per instance/AMI)
 * tracked by the bound license configuration.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.ListUsageForLicenseConfigurationHttp)`.
 * @binding
 * @section Reading License Configurations
 * @example List Per-Resource License Usage
 * ```typescript
 * // init
 * const listUsage =
 *   yield* AWS.LicenseManager.ListUsageForLicenseConfiguration(licenses);
 *
 * // runtime
 * const { LicenseConfigurationUsageList } = yield* listUsage();
 * ```
 */
export interface ListUsageForLicenseConfiguration extends Binding.Service<
  ListUsageForLicenseConfiguration,
  "AWS.LicenseManager.ListUsageForLicenseConfiguration",
  (
    configuration: LicenseConfiguration,
  ) => Effect.Effect<
    (
      request?: ListUsageForLicenseConfigurationRequest,
    ) => Effect.Effect<
      licensemanager.ListUsageForLicenseConfigurationResponse,
      licensemanager.ListUsageForLicenseConfigurationError
    >
  >
> {}
export const ListUsageForLicenseConfiguration =
  Binding.Service<ListUsageForLicenseConfiguration>(
    "AWS.LicenseManager.ListUsageForLicenseConfiguration",
  );
