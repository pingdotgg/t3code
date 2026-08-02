import type * as rds from "@distilled.cloud/aws/rds";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ApplyPendingMaintenanceAction` operation (IAM action
 * `rds:ApplyPendingMaintenanceAction`).
 *
 * Applies (or schedules) a pending maintenance action on an RDS resource
 * — e.g. an ops function that rolls maintenance during a controlled window. Provide the implementation with
 * `Effect.provide(AWS.RDS.ApplyPendingMaintenanceActionHttp)`.
 * @binding
 * @section Maintenance
 * @example Apply Maintenance Immediately
 * ```typescript
 * const applyPendingMaintenanceAction =
 *   yield* AWS.RDS.ApplyPendingMaintenanceAction();
 *
 * yield* applyPendingMaintenanceAction({
 *   ResourceIdentifier: clusterArn,
 *   ApplyAction: "system-update",
 *   OptInType: "immediate",
 * });
 * ```
 */
export interface ApplyPendingMaintenanceAction extends Binding.Service<
  ApplyPendingMaintenanceAction,
  "AWS.RDS.ApplyPendingMaintenanceAction",
  () => Effect.Effect<
    (
      request: rds.ApplyPendingMaintenanceActionMessage,
    ) => Effect.Effect<
      rds.ApplyPendingMaintenanceActionResult,
      rds.ApplyPendingMaintenanceActionError
    >
  >
> {}
export const ApplyPendingMaintenanceAction =
  Binding.Service<ApplyPendingMaintenanceAction>(
    "AWS.RDS.ApplyPendingMaintenanceAction",
  );
