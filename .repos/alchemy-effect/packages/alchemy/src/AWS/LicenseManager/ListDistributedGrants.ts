import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListDistributedGrants}.
 */
export interface ListDistributedGrantsRequest
  extends licensemanager.ListDistributedGrantsRequest {}

/**
 * Runtime binding for `license-manager:ListDistributedGrants` — list the
 * grants this account has distributed to other accounts.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.ListDistributedGrantsHttp)`.
 * @binding
 * @section Managing Grants
 * @example List Distributed Grants
 * ```typescript
 * // init
 * const listDistributedGrants =
 *   yield* AWS.LicenseManager.ListDistributedGrants();
 *
 * // runtime
 * const { Grants } = yield* listDistributedGrants();
 * ```
 */
export interface ListDistributedGrants extends Binding.Service<
  ListDistributedGrants,
  "AWS.LicenseManager.ListDistributedGrants",
  () => Effect.Effect<
    (
      request?: ListDistributedGrantsRequest,
    ) => Effect.Effect<
      licensemanager.ListDistributedGrantsResponse,
      licensemanager.ListDistributedGrantsError
    >
  >
> {}
export const ListDistributedGrants = Binding.Service<ListDistributedGrants>(
  "AWS.LicenseManager.ListDistributedGrants",
);
