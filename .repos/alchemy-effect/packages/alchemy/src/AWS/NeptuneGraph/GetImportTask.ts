import type * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `GetImportTask` operation (IAM action `neptune-graph:GetImportTask`).
 *
 * Reads one import task by id — status, progress statistics, and parsed-record counts. Task ids are server-generated runtime data. Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.GetImportTaskHttp)`.
 * @binding
 * @section Importing and Exporting Data
 * @example Poll an import task
 * ```typescript
 * const getImportTask = yield* NeptuneGraph.GetImportTask();
 *
 * const task = yield* getImportTask({ taskIdentifier });
 * // task.status → "SUCCEEDED"
 * ```
 */
export interface GetImportTask extends Binding.Service<
  GetImportTask,
  "AWS.NeptuneGraph.GetImportTask",
  () => Effect.Effect<
    (
      request: neptunegraph.GetImportTaskInput,
    ) => Effect.Effect<
      neptunegraph.GetImportTaskOutput,
      neptunegraph.GetImportTaskError
    >
  >
> {}
export const GetImportTask = Binding.Service<GetImportTask>(
  "AWS.NeptuneGraph.GetImportTask",
);
