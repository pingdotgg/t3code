import type * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `CancelImportTask` operation (IAM action `neptune-graph:CancelImportTask`).
 *
 * Cancels a running import task by id. Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.CancelImportTaskHttp)`.
 * @binding
 * @section Importing and Exporting Data
 * @example Cancel an import
 * ```typescript
 * const cancelImport = yield* NeptuneGraph.CancelImportTask();
 *
 * yield* cancelImport({ taskIdentifier });
 * ```
 */
export interface CancelImportTask extends Binding.Service<
  CancelImportTask,
  "AWS.NeptuneGraph.CancelImportTask",
  () => Effect.Effect<
    (
      request: neptunegraph.CancelImportTaskInput,
    ) => Effect.Effect<
      neptunegraph.CancelImportTaskOutput,
      neptunegraph.CancelImportTaskError
    >
  >
> {}
export const CancelImportTask = Binding.Service<CancelImportTask>(
  "AWS.NeptuneGraph.CancelImportTask",
);
