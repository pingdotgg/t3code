import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link CreateLicenseVersion}.
 */
export interface CreateLicenseVersionRequest
  extends licensemanager.CreateLicenseVersionRequest {}

/**
 * Runtime binding for `license-manager:CreateLicenseVersion` — publish a new
 * version of an existing seller-issued license (changed entitlements,
 * extended validity, a status flip to `AVAILABLE`/`DEACTIVATED`). Pass the
 * current version as `SourceVersion`.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.CreateLicenseVersionHttp)`.
 * @binding
 * @section Issuing Licenses
 * @example Extend a License's Validity
 * ```typescript
 * // init
 * const createLicenseVersion = yield* AWS.LicenseManager.CreateLicenseVersion();
 *
 * // runtime — read the current definition, publish an amended version
 * const { License } = yield* getLicense({ LicenseArn: licenseArn });
 * yield* createLicenseVersion({
 *   LicenseArn: licenseArn,
 *   LicenseName: License!.LicenseName!,
 *   ProductName: License!.ProductName!,
 *   Issuer: { Name: License!.Issuer!.Name! },
 *   HomeRegion: License!.HomeRegion!,
 *   Validity: { Begin: License!.Validity!.Begin, End: newEnd },
 *   Entitlements: License!.Entitlements!,
 *   ConsumptionConfiguration: License!.ConsumptionConfiguration!,
 *   Status: "AVAILABLE",
 *   SourceVersion: License!.Version,
 *   ClientToken: crypto.randomUUID(),
 * });
 * ```
 */
export interface CreateLicenseVersion extends Binding.Service<
  CreateLicenseVersion,
  "AWS.LicenseManager.CreateLicenseVersion",
  () => Effect.Effect<
    (
      request: CreateLicenseVersionRequest,
    ) => Effect.Effect<
      licensemanager.CreateLicenseVersionResponse,
      licensemanager.CreateLicenseVersionError
    >
  >
> {}
export const CreateLicenseVersion = Binding.Service<CreateLicenseVersion>(
  "AWS.LicenseManager.CreateLicenseVersion",
);
