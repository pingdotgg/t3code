import type * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ApplyPendingMaintenanceAction` operation (IAM
 * action `docdb-elastic:ApplyPendingMaintenanceAction`).
 *
 * Opts a resource in to (or out of) a pending maintenance action — apply an
 * engine update immediately, at the next maintenance window, or undo an
 * earlier opt-in. Provide the implementation with
 * `Effect.provide(AWS.DocDBElastic.ApplyPendingMaintenanceActionHttp)`.
 * @binding
 * @section Scheduling Maintenance
 * @example Apply Maintenance at the Next Window
 * ```typescript
 * const applyPending = yield* DocDBElastic.ApplyPendingMaintenanceAction();
 *
 * yield* applyPending({
 *   resourceArn: cluster.clusterArn,
 *   applyAction: "ENGINE_UPDATE",
 *   optInType: "NEXT_MAINTENANCE",
 * });
 * ```
 */
export interface ApplyPendingMaintenanceAction extends Binding.Service<
  ApplyPendingMaintenanceAction,
  "AWS.DocDBElastic.ApplyPendingMaintenanceAction",
  () => Effect.Effect<
    (
      request: docdbelastic.ApplyPendingMaintenanceActionInput,
    ) => Effect.Effect<
      docdbelastic.ApplyPendingMaintenanceActionOutput,
      docdbelastic.ApplyPendingMaintenanceActionError
    >
  >
> {}
export const ApplyPendingMaintenanceAction =
  Binding.Service<ApplyPendingMaintenanceAction>(
    "AWS.DocDBElastic.ApplyPendingMaintenanceAction",
  );
