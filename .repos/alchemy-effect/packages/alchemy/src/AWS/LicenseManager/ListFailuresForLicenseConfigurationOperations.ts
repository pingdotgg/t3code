import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LicenseConfiguration } from "./LicenseConfiguration.ts";

/**
 * Request for {@link ListFailuresForLicenseConfigurationOperations}. The bound configuration's ARN is injected
 * automatically.
 */
export interface ListFailuresForLicenseConfigurationOperationsRequest extends Omit<
  licensemanager.ListFailuresForLicenseConfigurationOperationsRequest,
  "LicenseConfigurationArn"
> {}

/**
 * Runtime binding for
 * `license-manager:ListFailuresForLicenseConfigurationOperations` — list
 * association/disassociation operations that failed for the bound license
 * configuration (e.g. a hard-limit rejection at instance launch).
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.ListFailuresForLicenseConfigurationOperationsHttp)`.
 * @binding
 * @section Reading License Configurations
 * @example List Failed License Operations
 * ```typescript
 * // init
 * const listFailures =
 *   yield* AWS.LicenseManager.ListFailuresForLicenseConfigurationOperations(
 *     licenses,
 *   );
 *
 * // runtime
 * const { LicenseOperationFailureList } = yield* listFailures();
 * ```
 */
export interface ListFailuresForLicenseConfigurationOperations extends Binding.Service<
  ListFailuresForLicenseConfigurationOperations,
  "AWS.LicenseManager.ListFailuresForLicenseConfigurationOperations",
  (
    configuration: LicenseConfiguration,
  ) => Effect.Effect<
    (
      request?: ListFailuresForLicenseConfigurationOperationsRequest,
    ) => Effect.Effect<
      licensemanager.ListFailuresForLicenseConfigurationOperationsResponse,
      licensemanager.ListFailuresForLicenseConfigurationOperationsError
    >
  >
> {}
export const ListFailuresForLicenseConfigurationOperations =
  Binding.Service<ListFailuresForLicenseConfigurationOperations>(
    "AWS.LicenseManager.ListFailuresForLicenseConfigurationOperations",
  );
