import type * as efs from "@distilled.cloud/aws/efs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FileSystem } from "./FileSystem.ts";

/**
 * Runtime binding for the `DescribeLifecycleConfiguration` operation (IAM
 * action `elasticfilesystem:DescribeLifecycleConfiguration` on the file
 * system ARN).
 *
 * Reads the bound {@link FileSystem}'s lifecycle management rules — when
 * files transition between Standard, Infrequent Access, and Archive storage.
 * A file system without lifecycle management returns an empty array.
 * Provide the implementation with
 * `Effect.provide(AWS.EFS.DescribeLifecycleConfigurationHttp)`.
 * @binding
 * @section Lifecycle Management
 * @example Read the lifecycle policies
 * ```typescript
 * const describeLifecycleConfiguration =
 *   yield* AWS.EFS.DescribeLifecycleConfiguration(files);
 *
 * const { LifecyclePolicies } = yield* describeLifecycleConfiguration();
 * ```
 */
export interface DescribeLifecycleConfiguration extends Binding.Service<
  DescribeLifecycleConfiguration,
  "AWS.EFS.DescribeLifecycleConfiguration",
  (
    fileSystem: FileSystem,
  ) => Effect.Effect<
    () => Effect.Effect<
      efs.LifecycleConfigurationDescription,
      efs.DescribeLifecycleConfigurationError
    >
  >
> {}
export const DescribeLifecycleConfiguration =
  Binding.Service<DescribeLifecycleConfiguration>(
    "AWS.EFS.DescribeLifecycleConfiguration",
  );
