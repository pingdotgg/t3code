import type * as docdb from "@distilled.cloud/aws/docdb";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

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
 * ### Maintenance
 * **Example:** List Pending Maintenance across the Account
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
 *
 * @binding
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
export const DescribePendingMaintenanceActions = Binding.Service<DescribePendingMaintenanceActions>(
  "AWS.DocDB.DescribePendingMaintenanceActions",
);
