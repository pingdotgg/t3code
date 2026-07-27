import type * as fsx from "@distilled.cloud/aws/fsx";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FileSystem } from "./FileSystem.ts";

/**
 * Runtime binding for the `CreateDataRepositoryTask` operation scoped to one
 * Lustre file system (IAM actions `fsx:CreateDataRepositoryTask` and
 * `fsx:TagResource` on the file system ARN and on `arn:aws:fsx:*:*:task/*`).
 *
 * Starts a bulk data movement between the bound Lustre {@link FileSystem}
 * and its linked S3 data repository — `EXPORT_TO_REPOSITORY`,
 * `IMPORT_METADATA_FROM_REPOSITORY`, or `RELEASE_DATA_FROM_FILESYSTEM` —
 * from inside a function runtime, e.g. exporting results after a compute
 * job completes. A task already executing surfaces the typed
 * `DataRepositoryTaskExecuting`. Provide the implementation with
 * `Effect.provide(AWS.FSx.CreateDataRepositoryTaskHttp)`.
 * @binding
 * @section Data Repository Tasks
 * @example Export results to the linked S3 repository
 * ```typescript
 * const createDataRepositoryTask =
 *   yield* AWS.FSx.CreateDataRepositoryTask(scratch);
 *
 * const response = yield* createDataRepositoryTask({
 *   Type: "EXPORT_TO_REPOSITORY",
 *   Paths: ["results/"],
 *   Report: { Enabled: false },
 * });
 * yield* Effect.log(`task ${response.DataRepositoryTask?.TaskId} started`);
 * ```
 */
export interface CreateDataRepositoryTask extends Binding.Service<
  CreateDataRepositoryTask,
  "AWS.FSx.CreateDataRepositoryTask",
  (
    fileSystem: FileSystem,
  ) => Effect.Effect<
    (
      request: Omit<fsx.CreateDataRepositoryTaskRequest, "FileSystemId">,
    ) => Effect.Effect<
      fsx.CreateDataRepositoryTaskResponse,
      fsx.CreateDataRepositoryTaskError
    >
  >
> {}
export const CreateDataRepositoryTask =
  Binding.Service<CreateDataRepositoryTask>("AWS.FSx.CreateDataRepositoryTask");
