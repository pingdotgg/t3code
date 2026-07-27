import type * as efs from "@distilled.cloud/aws/efs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FileSystem } from "./FileSystem.ts";

/**
 * `DescribeReplicationConfigurations` request with `FileSystemId` injected
 * from the bound {@link FileSystem}.
 */
export interface DescribeReplicationConfigurationsRequest extends Omit<
  efs.DescribeReplicationConfigurationsRequest,
  "FileSystemId"
> {}

/**
 * Runtime binding for the `DescribeReplicationConfigurations` operation (IAM
 * action `elasticfilesystem:DescribeReplicationConfigurations` on the file
 * system ARN).
 *
 * Reads the bound {@link FileSystem}'s replication configuration —
 * destination file systems, replication status, and last-replicated
 * timestamps. A file system with no replication fails with the typed
 * `ReplicationNotFound`. Provide the implementation with
 * `Effect.provide(AWS.EFS.DescribeReplicationConfigurationsHttp)`.
 * @binding
 * @section Replication
 * @example Check replication health
 * ```typescript
 * const describeReplicationConfigurations =
 *   yield* AWS.EFS.DescribeReplicationConfigurations(files);
 *
 * const status = yield* describeReplicationConfigurations().pipe(
 *   Effect.map((r) => r.Replications?.[0]?.Destinations[0]?.Status),
 *   Effect.catchTag("ReplicationNotFound", () => Effect.succeed(undefined)),
 * );
 * ```
 */
export interface DescribeReplicationConfigurations extends Binding.Service<
  DescribeReplicationConfigurations,
  "AWS.EFS.DescribeReplicationConfigurations",
  (
    fileSystem: FileSystem,
  ) => Effect.Effect<
    (
      request?: DescribeReplicationConfigurationsRequest,
    ) => Effect.Effect<
      efs.DescribeReplicationConfigurationsResponse,
      efs.DescribeReplicationConfigurationsError
    >
  >
> {}
export const DescribeReplicationConfigurations =
  Binding.Service<DescribeReplicationConfigurations>(
    "AWS.EFS.DescribeReplicationConfigurations",
  );
