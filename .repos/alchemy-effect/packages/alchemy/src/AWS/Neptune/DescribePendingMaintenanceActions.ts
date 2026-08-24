import type * as neptune from "@distilled.cloud/aws/neptune";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribePendingMaintenanceActions` operation (IAM
 * action `rds:DescribePendingMaintenanceActions`).
 *
 * Lists pending maintenance actions (engine patches, system updates) for the
 * account's Neptune resources — pair with
 * {@link ApplyPendingMaintenanceAction} for maintenance automation. Provide
 * the implementation with
 * `Effect.provide(AWS.Neptune.DescribePendingMaintenanceActionsHttp)`.
 * @binding
 * @section Maintenance
 * @example List Pending Maintenance
 * ```typescript
 * const describePendingMaintenanceActions =
 *   yield* AWS.Neptune.DescribePendingMaintenanceActions();
 *
 * const page = yield* describePendingMaintenanceActions();
 * const pending = page.PendingMaintenanceActions ?? [];
 * ```
 */
export interface DescribePendingMaintenanceActions extends Binding.Service<
  DescribePendingMaintenanceActions,
  "AWS.Neptune.DescribePendingMaintenanceActions",
  () => Effect.Effect<
    (
      request?: neptune.DescribePendingMaintenanceActionsMessage,
    ) => Effect.Effect<
      neptune.PendingMaintenanceActionsMessage,
      neptune.DescribePendingMaintenanceActionsError
    >
  >
> {}
export const DescribePendingMaintenanceActions =
  Binding.Service<DescribePendingMaintenanceActions>(
    "AWS.Neptune.DescribePendingMaintenanceActions",
  );
