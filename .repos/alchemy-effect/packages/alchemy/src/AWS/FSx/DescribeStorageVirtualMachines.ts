import type * as fsx from "@distilled.cloud/aws/fsx";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeStorageVirtualMachines` operation (IAM
 * action `fsx:DescribeStorageVirtualMachines` on `*`).
 *
 * Lists FSx for ONTAP storage virtual machines (SVMs) — optionally filtered
 * by `file-system-id` — from inside a function runtime, e.g. to resolve an
 * SVM's endpoints before opening an iSCSI/NFS session. Provide the
 * implementation with
 * `Effect.provide(AWS.FSx.DescribeStorageVirtualMachinesHttp)`.
 * @binding
 * @section Inspecting File Systems
 * @example List a file system's SVMs
 * ```typescript
 * const describeStorageVirtualMachines =
 *   yield* AWS.FSx.DescribeStorageVirtualMachines();
 *
 * const response = yield* describeStorageVirtualMachines({
 *   Filters: [{ Name: "file-system-id", Values: [fileSystemId] }],
 * });
 * yield* Effect.log(
 *   `${response.StorageVirtualMachines?.length ?? 0} SVMs`,
 * );
 * ```
 */
export interface DescribeStorageVirtualMachines extends Binding.Service<
  DescribeStorageVirtualMachines,
  "AWS.FSx.DescribeStorageVirtualMachines",
  () => Effect.Effect<
    (
      request?: fsx.DescribeStorageVirtualMachinesRequest,
    ) => Effect.Effect<
      fsx.DescribeStorageVirtualMachinesResponse,
      fsx.DescribeStorageVirtualMachinesError
    >
  >
> {}
export const DescribeStorageVirtualMachines =
  Binding.Service<DescribeStorageVirtualMachines>(
    "AWS.FSx.DescribeStorageVirtualMachines",
  );
