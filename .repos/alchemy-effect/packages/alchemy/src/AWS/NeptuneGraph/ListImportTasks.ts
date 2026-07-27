import type * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ListImportTasks` operation (IAM action `neptune-graph:ListImportTasks`).
 *
 * Lists the account's Neptune Analytics import tasks. Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.ListImportTasksHttp)`.
 * @binding
 * @section Importing and Exporting Data
 * @example List import tasks
 * ```typescript
 * const listImportTasks = yield* NeptuneGraph.ListImportTasks();
 *
 * const { tasks } = yield* listImportTasks();
 * ```
 */
export interface ListImportTasks extends Binding.Service<
  ListImportTasks,
  "AWS.NeptuneGraph.ListImportTasks",
  () => Effect.Effect<
    (
      request?: neptunegraph.ListImportTasksInput,
    ) => Effect.Effect<
      neptunegraph.ListImportTasksOutput,
      neptunegraph.ListImportTasksError
    >
  >
> {}
export const ListImportTasks = Binding.Service<ListImportTasks>(
  "AWS.NeptuneGraph.ListImportTasks",
);
