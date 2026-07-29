import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListReceivedLicenses}.
 */
export interface ListReceivedLicensesRequest
  extends licensemanager.ListReceivedLicensesRequest {}

/**
 * Runtime binding for `license-manager:ListReceivedLicenses` — list the
 * licenses granted to the account (e.g. AWS Marketplace entitlements),
 * the consumer-side counterpart of {@link ListLicenses}.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.ListReceivedLicensesHttp)`.
 * @binding
 * @section Reading Licenses and Grants
 * @example List Received Licenses
 * ```typescript
 * // init
 * const listReceived = yield* AWS.LicenseManager.ListReceivedLicenses();
 *
 * // runtime
 * const { Licenses } = yield* listReceived();
 * ```
 */
export interface ListReceivedLicenses extends Binding.Service<
  ListReceivedLicenses,
  "AWS.LicenseManager.ListReceivedLicenses",
  () => Effect.Effect<
    (
      request?: ListReceivedLicensesRequest,
    ) => Effect.Effect<
      licensemanager.ListReceivedLicensesResponse,
      licensemanager.ListReceivedLicensesError
    >
  >
> {}
export const ListReceivedLicenses = Binding.Service<ListReceivedLicenses>(
  "AWS.LicenseManager.ListReceivedLicenses",
);
