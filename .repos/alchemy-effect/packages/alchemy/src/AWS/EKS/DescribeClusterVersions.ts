import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `eks:DescribeClusterVersions`.
 *
 * Reads the Kubernetes version catalog — which versions EKS currently offers, their support status, and end-of-support dates.
 * `eks:DescribeClusterVersions` is granted on `*` — the operation is account-scoped and takes no resource.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.DescribeClusterVersionsHttp)`.
 * @binding
 * @section Version Catalogs
 * @example Find the Default Kubernetes Version
 * ```typescript
 * // init
 * const describeClusterVersions = yield* AWS.EKS.DescribeClusterVersions();
 *
 * // runtime
 * const { clusterVersions } = yield* describeClusterVersions({
 *   defaultOnly: true,
 * });
 * ```
 */
export interface DescribeClusterVersions extends Binding.Service<
  DescribeClusterVersions,
  "AWS.EKS.DescribeClusterVersions",
  () => Effect.Effect<
    (
      request?: eks.DescribeClusterVersionsRequest,
    ) => Effect.Effect<
      eks.DescribeClusterVersionsResponse,
      eks.DescribeClusterVersionsError
    >
  >
> {}
export const DescribeClusterVersions = Binding.Service<DescribeClusterVersions>(
  "AWS.EKS.DescribeClusterVersions",
);
