import type * as efs from "@distilled.cloud/aws/efs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FileSystem } from "./FileSystem.ts";

/**
 * `DescribeMountTargets` request with `FileSystemId` injected from the bound
 * {@link FileSystem}.
 */
export interface DescribeMountTargetsRequest extends Omit<
  efs.DescribeMountTargetsRequest,
  "FileSystemId"
> {}

/**
 * Runtime binding for the `DescribeMountTargets` operation (IAM action
 * `elasticfilesystem:DescribeMountTargets` on the file system ARN).
 *
 * Lists the bound {@link FileSystem}'s mount targets — the per-AZ NFS
 * endpoints with their IP addresses and lifecycle states. Useful for health
 * checks and for compute that needs to discover a mount target's IP at
 * runtime. Provide the implementation with
 * `Effect.provide(AWS.EFS.DescribeMountTargetsHttp)`.
 * @binding
 * @section Inspecting File Systems
 * @example List the file system's mount targets
 * ```typescript
 * const describeMountTargets = yield* AWS.EFS.DescribeMountTargets(files);
 *
 * const { MountTargets } = yield* describeMountTargets();
 * for (const target of MountTargets ?? []) {
 *   yield* Effect.log(`${target.AvailabilityZoneName}: ${target.IpAddress}`);
 * }
 * ```
 */
export interface DescribeMountTargets extends Binding.Service<
  DescribeMountTargets,
  "AWS.EFS.DescribeMountTargets",
  (
    fileSystem: FileSystem,
  ) => Effect.Effect<
    (
      request?: DescribeMountTargetsRequest,
    ) => Effect.Effect<
      efs.DescribeMountTargetsResponse,
      efs.DescribeMountTargetsError
    >
  >
> {}
export const DescribeMountTargets = Binding.Service<DescribeMountTargets>(
  "AWS.EFS.DescribeMountTargets",
);
