import type * as efs from "@distilled.cloud/aws/efs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FileSystem } from "./FileSystem.ts";

/**
 * Runtime binding for the `DescribeFileSystems` operation scoped to one file
 * system (IAM action `elasticfilesystem:DescribeFileSystems` on the file
 * system ARN).
 *
 * Reads the bound {@link FileSystem}'s live description — lifecycle state,
 * size in each storage class, throughput mode, mount target count — from
 * inside a function runtime. Useful for storage dashboards and capacity
 * monitors. Provide the implementation with
 * `Effect.provide(AWS.EFS.DescribeFileSystemHttp)`.
 * @binding
 * @section Inspecting File Systems
 * @example Read the file system's size and state
 * ```typescript
 * // init — bind the operation to the file system
 * const describeFileSystem = yield* AWS.EFS.DescribeFileSystem(files);
 *
 * // runtime
 * const response = yield* describeFileSystem();
 * const fs = response.FileSystems?.[0];
 * yield* Effect.log(`${fs?.LifeCycleState}: ${fs?.SizeInBytes?.Value} bytes`);
 * ```
 */
export interface DescribeFileSystem extends Binding.Service<
  DescribeFileSystem,
  "AWS.EFS.DescribeFileSystem",
  (
    fileSystem: FileSystem,
  ) => Effect.Effect<
    () => Effect.Effect<
      efs.DescribeFileSystemsResponse,
      efs.DescribeFileSystemsError
    >
  >
> {}
export const DescribeFileSystem = Binding.Service<DescribeFileSystem>(
  "AWS.EFS.DescribeFileSystem",
);
