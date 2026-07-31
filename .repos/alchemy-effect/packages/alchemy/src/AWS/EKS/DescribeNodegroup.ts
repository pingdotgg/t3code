import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:DescribeNodegroup`.
 *
 * Reads one managed node group's full state — scaling config, instance types, AMI release version, health issues.
 * The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:DescribeNodegroup` is granted on the cluster's sub-resource ARNs.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.DescribeNodegroupHttp)`.
 * @binding
 * @section Inspecting Compute
 * @example Check a Node Group's Health
 * ```typescript
 * // init
 * const describeNodegroup = yield* AWS.EKS.DescribeNodegroup(cluster);
 *
 * // runtime
 * const { nodegroup } = yield* describeNodegroup({ nodegroupName: "general" });
 * const issues = nodegroup?.health?.issues ?? [];
 * ```
 */
export interface DescribeNodegroup extends Binding.Service<
  DescribeNodegroup,
  "AWS.EKS.DescribeNodegroup",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: Omit<eks.DescribeNodegroupRequest, "clusterName">,
    ) => Effect.Effect<
      eks.DescribeNodegroupResponse,
      eks.DescribeNodegroupError
    >
  >
> {}
export const DescribeNodegroup = Binding.Service<DescribeNodegroup>(
  "AWS.EKS.DescribeNodegroup",
);
