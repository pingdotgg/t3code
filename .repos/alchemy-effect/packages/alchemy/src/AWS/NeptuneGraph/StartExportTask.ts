import type * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for the `StartExportTask` operation (IAM action `neptune-graph:StartExportTask`),
 * scoped to one {@link Graph}.
 *
 * Exports the bound graph's data to Amazon S3 (the graph must be `AVAILABLE`). The request passes Neptune Analytics a data-access role, so the grant includes `iam:PassRole` conditioned to `neptune-graph.amazonaws.com`. Poll progress with {@link GetExportTask}. Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.StartExportTaskHttp)`.
 * @binding
 * @section Importing and Exporting Data
 * @example Export a graph to S3 as Parquet
 * ```typescript
 * const startExport = yield* NeptuneGraph.StartExportTask(graph);
 *
 * const task = yield* startExport({
 *   destination: "s3://my-bucket/exports/",
 *   format: "PARQUET",
 *   kmsKeyIdentifier: key.keyArn,
 *   roleArn: exportRole.roleArn,
 * });
 * ```
 */
export interface StartExportTask extends Binding.Service<
  StartExportTask,
  "AWS.NeptuneGraph.StartExportTask",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request: Omit<neptunegraph.StartExportTaskInput, "graphIdentifier">,
    ) => Effect.Effect<
      neptunegraph.StartExportTaskOutput,
      neptunegraph.StartExportTaskError
    >
  >
> {}
export const StartExportTask = Binding.Service<StartExportTask>(
  "AWS.NeptuneGraph.StartExportTask",
);
