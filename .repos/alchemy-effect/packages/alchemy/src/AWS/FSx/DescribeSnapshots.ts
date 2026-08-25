import type * as fsx from "@distilled.cloud/aws/fsx";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeSnapshots` operation (IAM action
 * `fsx:DescribeSnapshots` on `*`).
 *
 * Lists FSx for OpenZFS snapshots — optionally filtered by `volume-id` or
 * `file-system-id` — from inside a function runtime. Pairs with
 * {@link CreateSnapshot} to poll a runtime-initiated snapshot until it
 * reaches `AVAILABLE`. Provide the implementation with
 * `Effect.provide(AWS.FSx.DescribeSnapshotsHttp)`.
 * @binding
 * @section Managing Snapshots at Runtime
 * @example List a volume's snapshots
 * ```typescript
 * const describeSnapshots = yield* AWS.FSx.DescribeSnapshots();
 *
 * const response = yield* describeSnapshots({
 *   Filters: [{ Name: "volume-id", Values: [volumeId] }],
 * });
 * yield* Effect.log(`${response.Snapshots?.length ?? 0} snapshots`);
 * ```
 */
export interface DescribeSnapshots extends Binding.Service<
  DescribeSnapshots,
  "AWS.FSx.DescribeSnapshots",
  () => Effect.Effect<
    (
      request?: fsx.DescribeSnapshotsRequest,
    ) => Effect.Effect<
      fsx.DescribeSnapshotsResponse,
      fsx.DescribeSnapshotsError
    >
  >
> {}
export const DescribeSnapshots = Binding.Service<DescribeSnapshots>(
  "AWS.FSx.DescribeSnapshots",
);
