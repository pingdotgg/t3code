import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListResourceInventory}.
 */
export interface ListResourceInventoryRequest
  extends licensemanager.ListResourceInventoryRequest {}

/**
 * Runtime binding for `license-manager:ListResourceInventory` — list the
 * resource inventory (instances and their platform details) discovered by
 * License Manager via Systems Manager inventory.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.ListResourceInventoryHttp)`.
 * @binding
 * @section Resource Inventory and Specifications
 * @example List Discovered Resources
 * ```typescript
 * // init
 * const listInventory = yield* AWS.LicenseManager.ListResourceInventory();
 *
 * // runtime
 * const { ResourceInventoryList } = yield* listInventory();
 * ```
 */
export interface ListResourceInventory extends Binding.Service<
  ListResourceInventory,
  "AWS.LicenseManager.ListResourceInventory",
  () => Effect.Effect<
    (
      request?: ListResourceInventoryRequest,
    ) => Effect.Effect<
      licensemanager.ListResourceInventoryResponse,
      licensemanager.ListResourceInventoryError
    >
  >
> {}
export const ListResourceInventory = Binding.Service<ListResourceInventory>(
  "AWS.LicenseManager.ListResourceInventory",
);
