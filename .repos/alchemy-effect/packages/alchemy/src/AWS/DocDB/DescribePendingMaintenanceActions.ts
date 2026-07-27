import type * as docdb from "@distilled.cloud/aws/docdb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribePendingMaintenanceActions` operation
 * (IAM action `rds:DescribePendingMaintenanceActions` — DocumentDB shares
 * the RDS control plane).
 *
 * Lists pending maintenance actions (engine patches, certificate
 * rotations) across the account's DocumentDB clusters and instances —
 * pairs with `ApplyPendingMaintenanceAction` for maintenance automation.
 * Provide the implementation with
 * `Effect.provide(AWS.DocDB.DescribePendingMaintenanceActionsHttp)`.
 * @binding
 * @section Maintenance
 * @example List Pending Maintenance across the Account
 * ```typescript
 * const describePending = yield* DocDB.DescribePendingMaintenanceActions();
 *
 * const page = yield* describePending();
 * for (const resource of page.PendingMaintenanceActions ?? []) {
 *   yield* Effect.log(
 *     `${resource.ResourceIdentifier}: ${resource.PendingMaintenanceActionDetails?.length} pending`,
 *   );
 * }
 * ```
 */
export interface DescribePendingMaintenanceActions extends Binding.Service<
  DescribePendingMaintenanceActions,
  "AWS.DocDB.DescribePendingMaintenanceActions",
  () => Effect.Effect<
    (
      request?: docdb.DescribePendingMaintenanceActionsMessage,
    ) => Effect.Effect<
      docdb.PendingMaintenanceActionsMessage,
      docdb.DescribePendingMaintenanceActionsError
    >
  >
> {}
export const DescribePendingMaintenanceActions =
  Binding.Service<DescribePendingMaintenanceActions>(
    "AWS.DocDB.DescribePendingMaintenanceActions",
  );
