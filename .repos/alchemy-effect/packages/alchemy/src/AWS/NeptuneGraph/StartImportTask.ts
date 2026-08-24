import type * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for the `StartImportTask` operation (IAM action `neptune-graph:StartImportTask`),
 * scoped to one {@link Graph}.
 *
 * Starts a bulk import from Amazon S3 into the bound graph (the graph must be empty and `AVAILABLE`). The request passes Neptune Analytics a data-access role, so the grant includes `iam:PassRole` conditioned to `neptune-graph.amazonaws.com`. Poll progress with {@link GetImportTask}. Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.StartImportTaskHttp)`.
 * @binding
 * @section Importing and Exporting Data
 * @example Bulk-load CSV data from S3
 * ```typescript
 * const startImport = yield* NeptuneGraph.StartImportTask(graph);
 *
 * const task = yield* startImport({
 *   source: "s3://my-bucket/graph-data/",
 *   format: "CSV",
 *   roleArn: importRole.roleArn,
 * });
 * // task.taskId, task.status
 * ```
 */
export interface StartImportTask extends Binding.Service<
  StartImportTask,
  "AWS.NeptuneGraph.StartImportTask",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request: Omit<neptunegraph.StartImportTaskInput, "graphIdentifier">,
    ) => Effect.Effect<
      neptunegraph.StartImportTaskOutput,
      neptunegraph.StartImportTaskError
    >
  >
> {}
export const StartImportTask = Binding.Service<StartImportTask>(
  "AWS.NeptuneGraph.StartImportTask",
);
