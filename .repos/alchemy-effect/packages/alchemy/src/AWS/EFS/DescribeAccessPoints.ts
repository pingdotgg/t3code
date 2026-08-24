import type * as efs from "@distilled.cloud/aws/efs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FileSystem } from "./FileSystem.ts";

/**
 * `DescribeAccessPoints` request with `FileSystemId` injected from the bound
 * {@link FileSystem}.
 */
export interface DescribeAccessPointsRequest extends Omit<
  efs.DescribeAccessPointsRequest,
  "FileSystemId"
> {}

/**
 * Runtime binding for the `DescribeAccessPoints` operation (IAM action
 * `elasticfilesystem:DescribeAccessPoints` on the file system ARN).
 *
 * Lists the bound {@link FileSystem}'s access points — e.g. to enumerate the
 * per-tenant entry points created at runtime with
 * {@link CreateAccessPoint}. Provide the implementation with
 * `Effect.provide(AWS.EFS.DescribeAccessPointsHttp)`.
 * @binding
 * @section Managing Access Points at Runtime
 * @example List the file system's access points
 * ```typescript
 * const describeAccessPoints = yield* AWS.EFS.DescribeAccessPoints(files);
 *
 * const { AccessPoints } = yield* describeAccessPoints();
 * for (const accessPoint of AccessPoints ?? []) {
 *   yield* Effect.log(`${accessPoint.Name}: ${accessPoint.AccessPointId}`);
 * }
 * ```
 */
export interface DescribeAccessPoints extends Binding.Service<
  DescribeAccessPoints,
  "AWS.EFS.DescribeAccessPoints",
  (
    fileSystem: FileSystem,
  ) => Effect.Effect<
    (
      request?: DescribeAccessPointsRequest,
    ) => Effect.Effect<
      efs.DescribeAccessPointsResponse,
      efs.DescribeAccessPointsError
    >
  >
> {}
export const DescribeAccessPoints = Binding.Service<DescribeAccessPoints>(
  "AWS.EFS.DescribeAccessPoints",
);
