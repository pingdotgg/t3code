import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:DescribeAddon`.
 *
 * Reads one installed add-on's state — version, status, health issues, and pod identity associations.
 * The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:DescribeAddon` is granted on the cluster's sub-resource ARNs.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.DescribeAddonHttp)`.
 * @binding
 * @section Inspecting Add-ons
 * @example Check an Add-on's Version and Health
 * ```typescript
 * // init
 * const describeAddon = yield* AWS.EKS.DescribeAddon(cluster);
 *
 * // runtime
 * const { addon } = yield* describeAddon({ addonName: "vpc-cni" });
 * ```
 */
export interface DescribeAddon extends Binding.Service<
  DescribeAddon,
  "AWS.EKS.DescribeAddon",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: Omit<eks.DescribeAddonRequest, "clusterName">,
    ) => Effect.Effect<eks.DescribeAddonResponse, eks.DescribeAddonError>
  >
> {}
export const DescribeAddon = Binding.Service<DescribeAddon>(
  "AWS.EKS.DescribeAddon",
);
