import type * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `GetExportTask` operation (IAM action `neptune-graph:GetExportTask`).
 *
 * Reads one export task by id — status, progress percentage, and exported-record counts. Task ids are server-generated runtime data. Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.GetExportTaskHttp)`.
 * @binding
 * @section Importing and Exporting Data
 * @example Poll an export task
 * ```typescript
 * const getExportTask = yield* NeptuneGraph.GetExportTask();
 *
 * const task = yield* getExportTask({ taskIdentifier });
 * // task.status → "SUCCEEDED"
 * ```
 */
export interface GetExportTask extends Binding.Service<
  GetExportTask,
  "AWS.NeptuneGraph.GetExportTask",
  () => Effect.Effect<
    (
      request: neptunegraph.GetExportTaskInput,
    ) => Effect.Effect<
      neptunegraph.GetExportTaskOutput,
      neptunegraph.GetExportTaskError
    >
  >
> {}
export const GetExportTask = Binding.Service<GetExportTask>(
  "AWS.NeptuneGraph.GetExportTask",
);
