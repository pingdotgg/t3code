import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:DescribeCluster`.
 *
 * Reads the bound cluster's live control-plane state — status, Kubernetes API `endpoint`, `certificateAuthority` data, version, and network config. The building block for constructing a kubeconfig at runtime.
 * The cluster `name` is injected from the bound {@link Cluster} and `eks:DescribeCluster` is granted on the cluster's ARN.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.DescribeClusterHttp)`.
 * @binding
 * @section Reading Cluster State
 * @example Build Kubernetes Connection Settings at Runtime
 * ```typescript
 * // init
 * const describeCluster = yield* AWS.EKS.DescribeCluster(cluster);
 *
 * // runtime
 * const { cluster: live } = yield* describeCluster();
 * const endpoint = live?.endpoint;
 * const caData = live?.certificateAuthority?.data;
 * ```
 */
export interface DescribeCluster extends Binding.Service<
  DescribeCluster,
  "AWS.EKS.DescribeCluster",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: Omit<eks.DescribeClusterRequest, "name">,
    ) => Effect.Effect<eks.DescribeClusterResponse, eks.DescribeClusterError>
  >
> {}
export const DescribeCluster = Binding.Service<DescribeCluster>(
  "AWS.EKS.DescribeCluster",
);
