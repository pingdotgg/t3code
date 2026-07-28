import type * as fsx from "@distilled.cloud/aws/fsx";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeVolumes` operation (IAM action
 * `fsx:DescribeVolumes` on `*`).
 *
 * Lists FSx for ONTAP / OpenZFS volumes — optionally filtered by
 * `file-system-id` or `storage-virtual-machine-id` — from inside a function
 * runtime. Useful for discovering the volume ids that the snapshot bindings
 * operate on. Provide the implementation with
 * `Effect.provide(AWS.FSx.DescribeVolumesHttp)`.
 * @binding
 * @section Inspecting File Systems
 * @example List a file system's volumes
 * ```typescript
 * const describeVolumes = yield* AWS.FSx.DescribeVolumes();
 *
 * const response = yield* describeVolumes({
 *   Filters: [{ Name: "file-system-id", Values: [fileSystemId] }],
 * });
 * yield* Effect.log(`${response.Volumes?.length ?? 0} volumes`);
 * ```
 */
export interface DescribeVolumes extends Binding.Service<
  DescribeVolumes,
  "AWS.FSx.DescribeVolumes",
  () => Effect.Effect<
    (
      request?: fsx.DescribeVolumesRequest,
    ) => Effect.Effect<fsx.DescribeVolumesResponse, fsx.DescribeVolumesError>
  >
> {}
export const DescribeVolumes = Binding.Service<DescribeVolumes>(
  "AWS.FSx.DescribeVolumes",
);
