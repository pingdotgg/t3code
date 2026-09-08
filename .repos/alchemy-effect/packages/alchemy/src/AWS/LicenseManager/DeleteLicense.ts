import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link DeleteLicense}.
 */
export interface DeleteLicenseRequest
  extends licensemanager.DeleteLicenseRequest {}

/**
 * Runtime binding for `license-manager:DeleteLicense` — delete a
 * seller-issued license (e.g. on refund or subscription cancellation). The
 * license's current version must be passed as `SourceVersion`.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.DeleteLicenseHttp)`.
 * ### Issuing Licenses
 * **Example:** Delete a License on Cancellation
 * ```typescript
 * // init
 * const deleteLicense = yield* AWS.LicenseManager.DeleteLicense();
 *
 * // runtime
 * const { License } = yield* getLicense({ LicenseArn: licenseArn });
 * yield* deleteLicense({
 *   LicenseArn: licenseArn,
 *   SourceVersion: License!.Version!,
 * });
 * ```
 *
 * @binding
 */
export interface DeleteLicense extends Binding.Service<
  DeleteLicense,
  "AWS.LicenseManager.DeleteLicense",
  () => Effect.Effect<
    (
      request: DeleteLicenseRequest,
    ) => Effect.Effect<
      licensemanager.DeleteLicenseResponse,
      licensemanager.DeleteLicenseError
    >
  >
> {}
export const DeleteLicense = Binding.Service<DeleteLicense>(
  "AWS.LicenseManager.DeleteLicense",
);
