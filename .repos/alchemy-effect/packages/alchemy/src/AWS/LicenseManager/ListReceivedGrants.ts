import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListReceivedGrants}.
 */
export interface ListReceivedGrantsRequest
  extends licensemanager.ListReceivedGrantsRequest {}

/**
 * Runtime binding for `license-manager:ListReceivedGrants` — list the
 * grants distributed to this account, e.g. to find pending grants to
 * {@link AcceptGrant}.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.ListReceivedGrantsHttp)`.
 * @binding
 * @section Managing Grants
 * @example List Received Grants
 * ```typescript
 * // init
 * const listReceivedGrants =
 *   yield* AWS.LicenseManager.ListReceivedGrants();
 *
 * // runtime
 * const { Grants } = yield* listReceivedGrants();
 * ```
 */
export interface ListReceivedGrants extends Binding.Service<
  ListReceivedGrants,
  "AWS.LicenseManager.ListReceivedGrants",
  () => Effect.Effect<
    (
      request?: ListReceivedGrantsRequest,
    ) => Effect.Effect<
      licensemanager.ListReceivedGrantsResponse,
      licensemanager.ListReceivedGrantsError
    >
  >
> {}
export const ListReceivedGrants = Binding.Service<ListReceivedGrants>(
  "AWS.LicenseManager.ListReceivedGrants",
);
