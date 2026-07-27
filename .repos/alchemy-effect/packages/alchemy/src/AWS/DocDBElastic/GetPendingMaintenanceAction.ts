import type * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `GetPendingMaintenanceAction` operation (IAM
 * action `docdb-elastic:GetPendingMaintenanceAction`).
 *
 * Reads the pending maintenance actions for one resource (a cluster ARN) —
 * the action name, opt-in status, and apply dates. Provide the
 * implementation with
 * `Effect.provide(AWS.DocDBElastic.GetPendingMaintenanceActionHttp)`.
 * @binding
 * @section Scheduling Maintenance
 * @example Read a Cluster's Pending Maintenance
 * ```typescript
 * const getPending = yield* DocDBElastic.GetPendingMaintenanceAction();
 *
 * const result = yield* getPending({ resourceArn: cluster.clusterArn });
 * // result.resourcePendingMaintenanceAction.pendingMaintenanceActionDetails
 * ```
 */
export interface GetPendingMaintenanceAction extends Binding.Service<
  GetPendingMaintenanceAction,
  "AWS.DocDBElastic.GetPendingMaintenanceAction",
  () => Effect.Effect<
    (
      request: docdbelastic.GetPendingMaintenanceActionInput,
    ) => Effect.Effect<
      docdbelastic.GetPendingMaintenanceActionOutput,
      docdbelastic.GetPendingMaintenanceActionError
    >
  >
> {}
export const GetPendingMaintenanceAction =
  Binding.Service<GetPendingMaintenanceAction>(
    "AWS.DocDBElastic.GetPendingMaintenanceAction",
  );
