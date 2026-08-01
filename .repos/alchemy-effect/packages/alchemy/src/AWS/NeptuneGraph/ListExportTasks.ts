import type * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for the `ListExportTasks` operation (IAM action `neptune-graph:ListExportTasks`),
 * scoped to one {@link Graph}.
 *
 * Lists the export tasks of the bound graph. Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.ListExportTasksHttp)`.
 * @binding
 * @section Importing and Exporting Data
 * @example List a graph's export tasks
 * ```typescript
 * const listExportTasks = yield* NeptuneGraph.ListExportTasks(graph);
 *
 * const { tasks } = yield* listExportTasks();
 * ```
 */
export interface ListExportTasks extends Binding.Service<
  ListExportTasks,
  "AWS.NeptuneGraph.ListExportTasks",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request?: Omit<neptunegraph.ListExportTasksInput, "graphIdentifier">,
    ) => Effect.Effect<
      neptunegraph.ListExportTasksOutput,
      neptunegraph.ListExportTasksError
    >
  >
> {}
export const ListExportTasks = Binding.Service<ListExportTasks>(
  "AWS.NeptuneGraph.ListExportTasks",
);
