import type * as rds from "@distilled.cloud/aws/rds";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribePendingMaintenanceActions` operation (IAM action
 * `rds:DescribePendingMaintenanceActions`).
 *
 * Lists pending maintenance actions (engine upgrades, OS patches,
 * certificate rotations) across the account's RDS resources. Provide the implementation with
 * `Effect.provide(AWS.RDS.DescribePendingMaintenanceActionsHttp)`.
 * @binding
 * @section Maintenance
 * @example List Pending Maintenance
 * ```typescript
 * const describePendingMaintenanceActions =
 *   yield* AWS.RDS.DescribePendingMaintenanceActions();
 *
 * const page = yield* describePendingMaintenanceActions();
 * ```
 */
export interface DescribePendingMaintenanceActions extends Binding.Service<
  DescribePendingMaintenanceActions,
  "AWS.RDS.DescribePendingMaintenanceActions",
  () => Effect.Effect<
    (
      request?: rds.DescribePendingMaintenanceActionsMessage,
    ) => Effect.Effect<
      rds.PendingMaintenanceActionsMessage,
      rds.DescribePendingMaintenanceActionsError
    >
  >
> {}
export const DescribePendingMaintenanceActions =
  Binding.Service<DescribePendingMaintenanceActions>(
    "AWS.RDS.DescribePendingMaintenanceActions",
  );
