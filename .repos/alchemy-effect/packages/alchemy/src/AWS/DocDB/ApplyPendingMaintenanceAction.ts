import type * as docdb from "@distilled.cloud/aws/docdb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ApplyPendingMaintenanceAction` operation (IAM
 * action `rds:ApplyPendingMaintenanceAction` — DocumentDB shares the RDS
 * control plane).
 *
 * Opts a DocumentDB cluster or instance into a pending maintenance action
 * (`system-update`, `db-upgrade`, `ca-certificate-rotation`) immediately or
 * at the next maintenance window — the apply half of maintenance
 * automation. The target is an ARN carried in the request, so the grant
 * spans the account. Provide the implementation with
 * `Effect.provide(AWS.DocDB.ApplyPendingMaintenanceActionHttp)`.
 * @binding
 * @section Maintenance
 * @example Apply Maintenance at the Next Window
 * ```typescript
 * const applyPending = yield* DocDB.ApplyPendingMaintenanceAction();
 *
 * yield* applyPending({
 *   ResourceIdentifier: clusterArn,
 *   ApplyAction: "system-update",
 *   OptInType: "next-maintenance",
 * });
 * ```
 */
export interface ApplyPendingMaintenanceAction extends Binding.Service<
  ApplyPendingMaintenanceAction,
  "AWS.DocDB.ApplyPendingMaintenanceAction",
  () => Effect.Effect<
    (
      request: docdb.ApplyPendingMaintenanceActionMessage,
    ) => Effect.Effect<
      docdb.ApplyPendingMaintenanceActionResult,
      docdb.ApplyPendingMaintenanceActionError
    >
  >
> {}
export const ApplyPendingMaintenanceAction =
  Binding.Service<ApplyPendingMaintenanceAction>(
    "AWS.DocDB.ApplyPendingMaintenanceAction",
  );
