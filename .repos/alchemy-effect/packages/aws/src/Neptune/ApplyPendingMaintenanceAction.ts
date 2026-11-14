import type * as neptune from "@distilled.cloud/aws/neptune";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for the `ApplyPendingMaintenanceAction` operation (IAM
 * action `rds:ApplyPendingMaintenanceAction`).
 *
 * Opts a Neptune resource (by ARN) into a pending maintenance action — e.g.
 * apply an engine patch during the next maintenance window, or immediately.
 * Provide the implementation with
 * `Effect.provide(AWS.Neptune.ApplyPendingMaintenanceActionHttp)`.
 * ### Maintenance
 * **Example:** Apply Maintenance at the Next Window
 * ```typescript
 * const applyPendingMaintenanceAction =
 *   yield* AWS.Neptune.ApplyPendingMaintenanceAction();
 *
 * yield* applyPendingMaintenanceAction({
 *   ResourceIdentifier: clusterArn,
 *   ApplyAction: "system-update",
 *   OptInType: "next-maintenance",
 * });
 * ```
 *
 * @binding
 */
export interface ApplyPendingMaintenanceAction extends Binding.Service<
  ApplyPendingMaintenanceAction,
  "AWS.Neptune.ApplyPendingMaintenanceAction",
  () => Effect.Effect<
    (
      request?: neptune.ApplyPendingMaintenanceActionMessage,
    ) => Effect.Effect<
      neptune.ApplyPendingMaintenanceActionResult,
      neptune.ApplyPendingMaintenanceActionError
    >
  >
> {}
export const ApplyPendingMaintenanceAction = Binding.Service<ApplyPendingMaintenanceAction>(
  "AWS.Neptune.ApplyPendingMaintenanceAction",
);
