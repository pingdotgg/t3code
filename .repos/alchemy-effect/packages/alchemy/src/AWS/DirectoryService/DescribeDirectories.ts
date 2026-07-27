import type * as ds from "@distilled.cloud/aws/directory-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeDirectories` operation (IAM action
 * `ds:DescribeDirectories`).
 *
 * Reads directory descriptions at runtime — stage, DNS addresses, VPC
 * settings — for some or all of the account's directories. The action does
 * not support resource-level permissions, so the grant is account-wide.
 * Provide the implementation with
 * `Effect.provide(AWS.DirectoryService.DescribeDirectoriesHttp)`.
 * @binding
 * @section Reading Directories
 * @example Read a Directory's Stage and DNS Servers
 * ```typescript
 * // init — request the account-level capability
 * const describeDirectories = yield* AWS.DirectoryService.DescribeDirectories();
 *
 * // runtime
 * const { DirectoryDescriptions } = yield* describeDirectories({
 *   DirectoryIds: [directoryId],
 * });
 * const directory = DirectoryDescriptions?.[0];
 * console.log(directory?.Stage, directory?.DnsIpAddrs);
 * ```
 */
export interface DescribeDirectories extends Binding.Service<
  DescribeDirectories,
  "AWS.DirectoryService.DescribeDirectories",
  () => Effect.Effect<
    (
      request?: ds.DescribeDirectoriesRequest,
    ) => Effect.Effect<
      ds.DescribeDirectoriesResult,
      ds.DescribeDirectoriesError
    >
  >
> {}
export const DescribeDirectories = Binding.Service<DescribeDirectories>(
  "AWS.DirectoryService.DescribeDirectories",
);
