import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LicenseConfiguration } from "./LicenseConfiguration.ts";

/**
 * Request for {@link ListAssociationsForLicenseConfiguration}. The bound configuration's ARN is injected
 * automatically.
 */
export interface ListAssociationsForLicenseConfigurationRequest extends Omit<
  licensemanager.ListAssociationsForLicenseConfigurationRequest,
  "LicenseConfigurationArn"
> {}

/**
 * Runtime binding for
 * `license-manager:ListAssociationsForLicenseConfiguration` — list the
 * resources (instances, AMIs, hosts) currently associated with the bound
 * license configuration.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.ListAssociationsForLicenseConfigurationHttp)`.
 * @binding
 * @section Reading License Configurations
 * @example List the Configuration's Resource Associations
 * ```typescript
 * // init
 * const listAssociations =
 *   yield* AWS.LicenseManager.ListAssociationsForLicenseConfiguration(
 *     licenses,
 *   );
 *
 * // runtime
 * const { LicenseConfigurationAssociations } = yield* listAssociations();
 * ```
 */
export interface ListAssociationsForLicenseConfiguration extends Binding.Service<
  ListAssociationsForLicenseConfiguration,
  "AWS.LicenseManager.ListAssociationsForLicenseConfiguration",
  (
    configuration: LicenseConfiguration,
  ) => Effect.Effect<
    (
      request?: ListAssociationsForLicenseConfigurationRequest,
    ) => Effect.Effect<
      licensemanager.ListAssociationsForLicenseConfigurationResponse,
      licensemanager.ListAssociationsForLicenseConfigurationError
    >
  >
> {}
export const ListAssociationsForLicenseConfiguration =
  Binding.Service<ListAssociationsForLicenseConfiguration>(
    "AWS.LicenseManager.ListAssociationsForLicenseConfiguration",
  );
