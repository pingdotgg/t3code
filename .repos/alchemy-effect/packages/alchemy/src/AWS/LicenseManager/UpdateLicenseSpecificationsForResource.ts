import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link UpdateLicenseSpecificationsForResource}.
 */
export interface UpdateLicenseSpecificationsForResourceRequest
  extends licensemanager.UpdateLicenseSpecificationsForResourceRequest {}

/**
 * Runtime binding for
 * `license-manager:UpdateLicenseSpecificationsForResource` — associate or
 * disassociate license configurations with a resource (e.g. attach a
 * license configuration to an AMI so launches are tracked).
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.UpdateLicenseSpecificationsForResourceHttp)`.
 * @binding
 * @section Resource Inventory and Specifications
 * @example Attach a License Configuration to an AMI
 * ```typescript
 * // init
 * const updateSpecifications =
 *   yield* AWS.LicenseManager.UpdateLicenseSpecificationsForResource();
 *
 * // runtime
 * yield* updateSpecifications({
 *   ResourceArn: amiArn,
 *   AddLicenseSpecifications: [
 *     { LicenseConfigurationArn: configurationArn },
 *   ],
 * });
 * ```
 */
export interface UpdateLicenseSpecificationsForResource extends Binding.Service<
  UpdateLicenseSpecificationsForResource,
  "AWS.LicenseManager.UpdateLicenseSpecificationsForResource",
  () => Effect.Effect<
    (
      request: UpdateLicenseSpecificationsForResourceRequest,
    ) => Effect.Effect<
      licensemanager.UpdateLicenseSpecificationsForResourceResponse,
      licensemanager.UpdateLicenseSpecificationsForResourceError
    >
  >
> {}
export const UpdateLicenseSpecificationsForResource =
  Binding.Service<UpdateLicenseSpecificationsForResource>(
    "AWS.LicenseManager.UpdateLicenseSpecificationsForResource",
  );
