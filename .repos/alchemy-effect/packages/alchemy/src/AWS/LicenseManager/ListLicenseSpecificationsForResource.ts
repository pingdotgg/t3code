import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListLicenseSpecificationsForResource}.
 */
export interface ListLicenseSpecificationsForResourceRequest
  extends licensemanager.ListLicenseSpecificationsForResourceRequest {}

/**
 * Runtime binding for
 * `license-manager:ListLicenseSpecificationsForResource` — list the
 * license configurations associated with a resource (e.g. an AMI or
 * instance).
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.ListLicenseSpecificationsForResourceHttp)`.
 * @binding
 * @section Resource Inventory and Specifications
 * @example List a Resource's License Specifications
 * ```typescript
 * // init
 * const listSpecifications =
 *   yield* AWS.LicenseManager.ListLicenseSpecificationsForResource();
 *
 * // runtime
 * const { LicenseSpecifications } = yield* listSpecifications({
 *   ResourceArn: amiArn,
 * });
 * ```
 */
export interface ListLicenseSpecificationsForResource extends Binding.Service<
  ListLicenseSpecificationsForResource,
  "AWS.LicenseManager.ListLicenseSpecificationsForResource",
  () => Effect.Effect<
    (
      request: ListLicenseSpecificationsForResourceRequest,
    ) => Effect.Effect<
      licensemanager.ListLicenseSpecificationsForResourceResponse,
      licensemanager.ListLicenseSpecificationsForResourceError
    >
  >
> {}
export const ListLicenseSpecificationsForResource =
  Binding.Service<ListLicenseSpecificationsForResource>(
    "AWS.LicenseManager.ListLicenseSpecificationsForResource",
  );
