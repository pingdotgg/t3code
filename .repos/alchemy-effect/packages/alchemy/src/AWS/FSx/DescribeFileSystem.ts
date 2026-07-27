import type * as fsx from "@distilled.cloud/aws/fsx";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FileSystem } from "./FileSystem.ts";

/**
 * Runtime binding for the `DescribeFileSystems` operation scoped to one file
 * system (IAM action `fsx:DescribeFileSystems` on the file system ARN).
 *
 * Reads the bound {@link FileSystem}'s live description — lifecycle state,
 * storage capacity, DNS name, engine configuration — from inside a function
 * runtime. Useful for storage dashboards and capacity monitors. Provide the
 * implementation with `Effect.provide(AWS.FSx.DescribeFileSystemHttp)`.
 * @binding
 * @section Inspecting File Systems
 * @example Read the file system's state and capacity
 * ```typescript
 * // init — bind the operation to the file system
 * const describeFileSystem = yield* AWS.FSx.DescribeFileSystem(files);
 *
 * // runtime
 * const response = yield* describeFileSystem();
 * const fs = response.FileSystems?.[0];
 * yield* Effect.log(`${fs?.Lifecycle}: ${fs?.StorageCapacity} GiB`);
 * ```
 */
export interface DescribeFileSystem extends Binding.Service<
  DescribeFileSystem,
  "AWS.FSx.DescribeFileSystem",
  (
    fileSystem: FileSystem,
  ) => Effect.Effect<
    () => Effect.Effect<
      fsx.DescribeFileSystemsResponse,
      fsx.DescribeFileSystemsError
    >
  >
> {}
export const DescribeFileSystem = Binding.Service<DescribeFileSystem>(
  "AWS.FSx.DescribeFileSystem",
);
