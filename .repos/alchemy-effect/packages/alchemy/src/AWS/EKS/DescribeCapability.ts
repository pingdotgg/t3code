import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:DescribeCapability`.
 *
 * Reads one EKS capability's full state — the managed capability (e.g. Argo CD) installed on the bound cluster, its status, version, and configuration.
 * The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:DescribeCapability` is granted on the cluster's sub-resource ARNs.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.DescribeCapabilityHttp)`.
 * @binding
 * @section Cluster Capabilities
 * @example Check a Capability's Status
 * ```typescript
 * // init
 * const describeCapability = yield* AWS.EKS.DescribeCapability(cluster);
 *
 * // runtime
 * const { capability } = yield* describeCapability({ capabilityName: "argocd" });
 * const status = capability?.status;
 * ```
 */
export interface DescribeCapability extends Binding.Service<
  DescribeCapability,
  "AWS.EKS.DescribeCapability",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: Omit<eks.DescribeCapabilityRequest, "clusterName">,
    ) => Effect.Effect<
      eks.DescribeCapabilityResponse,
      eks.DescribeCapabilityError
    >
  >
> {}
export const DescribeCapability = Binding.Service<DescribeCapability>(
  "AWS.EKS.DescribeCapability",
);
