import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListRunTasksRequest extends omics.ListRunTasksRequest {}

/**
 * Runtime binding for `omics:ListRunTasks`.
 *
 * An account-level run-control operation (no resource argument) that lists the tasks within a run.
 * Provide the implementation with `Effect.provide(AWS.Omics.ListRunTasksHttp)`.
 * @binding
 * @section Runs
 * @example Call ListRunTasks
 * ```typescript
 * // init — account-level binding takes no resource
 * const listRunTasks = yield* AWS.Omics.ListRunTasks();
 * // runtime
 * const result = yield* listRunTasks({ id: runId });
 * ```
 */
export interface ListRunTasks extends Binding.Service<
  ListRunTasks,
  "AWS.Omics.ListRunTasks",
  () => Effect.Effect<
    (
      request?: ListRunTasksRequest,
    ) => Effect.Effect<omics.ListRunTasksResponse, omics.ListRunTasksError>
  >
> {}

export const ListRunTasks = Binding.Service<ListRunTasks>(
  "AWS.Omics.ListRunTasks",
);
