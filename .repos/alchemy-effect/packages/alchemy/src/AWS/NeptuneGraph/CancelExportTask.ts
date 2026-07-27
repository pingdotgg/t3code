import type * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `CancelExportTask` operation (IAM action `neptune-graph:CancelExportTask`).
 *
 * Cancels a running export task by id. Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.CancelExportTaskHttp)`.
 * @binding
 * @section Importing and Exporting Data
 * @example Cancel an export
 * ```typescript
 * const cancelExport = yield* NeptuneGraph.CancelExportTask();
 *
 * yield* cancelExport({ taskIdentifier });
 * ```
 */
export interface CancelExportTask extends Binding.Service<
  CancelExportTask,
  "AWS.NeptuneGraph.CancelExportTask",
  () => Effect.Effect<
    (
      request: neptunegraph.CancelExportTaskInput,
    ) => Effect.Effect<
      neptunegraph.CancelExportTaskOutput,
      neptunegraph.CancelExportTaskError
    >
  >
> {}
export const CancelExportTask = Binding.Service<CancelExportTask>(
  "AWS.NeptuneGraph.CancelExportTask",
);
