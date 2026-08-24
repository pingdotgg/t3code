import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListLicenseVersions}.
 */
export interface ListLicenseVersionsRequest
  extends licensemanager.ListLicenseVersionsRequest {}

/**
 * Runtime binding for `license-manager:ListLicenseVersions` — list all
 * versions of a seller-issued license.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.ListLicenseVersionsHttp)`.
 * @binding
 * @section Reading Licenses and Grants
 * @example List a License's Versions
 * ```typescript
 * // init
 * const listVersions = yield* AWS.LicenseManager.ListLicenseVersions();
 *
 * // runtime
 * const { Licenses } = yield* listVersions({ LicenseArn: licenseArn });
 * ```
 */
export interface ListLicenseVersions extends Binding.Service<
  ListLicenseVersions,
  "AWS.LicenseManager.ListLicenseVersions",
  () => Effect.Effect<
    (
      request: ListLicenseVersionsRequest,
    ) => Effect.Effect<
      licensemanager.ListLicenseVersionsResponse,
      licensemanager.ListLicenseVersionsError
    >
  >
> {}
export const ListLicenseVersions = Binding.Service<ListLicenseVersions>(
  "AWS.LicenseManager.ListLicenseVersions",
);
