import type * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for the `ListPendingMaintenanceActions` operation (IAM
 * action `docdb-elastic:ListPendingMaintenanceActions`).
 *
 * Lists pending maintenance (e.g. engine updates) across every elastic
 * cluster in the account — feed it into an ops dashboard or a maintenance
 * scheduler. Provide the implementation with
 * `Effect.provide(AWS.DocDBElastic.ListPendingMaintenanceActionsHttp)`.
 * ### Scheduling Maintenance
 * **Example:** List All Pending Maintenance
 * ```typescript
 * const listPending = yield* DocDBElastic.ListPendingMaintenanceActions();
 *
 * const page = yield* listPending();
 * for (const action of page.resourcePendingMaintenanceActions ?? []) {
 *   yield* Effect.logInfo(action.resourceArn ?? "");
 * }
 * ```
 *
 * @binding
 */
export interface ListPendingMaintenanceActions extends Binding.Service<
  ListPendingMaintenanceActions,
  "AWS.DocDBElastic.ListPendingMaintenanceActions",
  () => Effect.Effect<
    (
      request?: docdbelastic.ListPendingMaintenanceActionsInput,
    ) => Effect.Effect<
      docdbelastic.ListPendingMaintenanceActionsOutput,
      docdbelastic.ListPendingMaintenanceActionsError
    >
  >
> {}
export const ListPendingMaintenanceActions = Binding.Service<ListPendingMaintenanceActions>(
  "AWS.DocDBElastic.ListPendingMaintenanceActions",
);
