import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListLicenses}.
 */
export interface ListLicensesRequest
  extends licensemanager.ListLicensesRequest {}

/**
 * Runtime binding for `license-manager:ListLicenses` — list the
 * seller-issued licenses owned by the account.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.ListLicensesHttp)`.
 * @binding
 * @section Reading Licenses and Grants
 * @example List Owned Licenses
 * ```typescript
 * // init
 * const listLicenses = yield* AWS.LicenseManager.ListLicenses();
 *
 * // runtime
 * const { Licenses } = yield* listLicenses();
 * ```
 */
export interface ListLicenses extends Binding.Service<
  ListLicenses,
  "AWS.LicenseManager.ListLicenses",
  () => Effect.Effect<
    (
      request?: ListLicensesRequest,
    ) => Effect.Effect<
      licensemanager.ListLicensesResponse,
      licensemanager.ListLicensesError
    >
  >
> {}
export const ListLicenses = Binding.Service<ListLicenses>(
  "AWS.LicenseManager.ListLicenses",
);
