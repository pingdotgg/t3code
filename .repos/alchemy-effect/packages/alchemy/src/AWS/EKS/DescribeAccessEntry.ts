import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:DescribeAccessEntry`.
 *
 * Reads one access entry — the Kubernetes username, groups, and type mapped to an IAM principal.
 * The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:DescribeAccessEntry` is granted on the cluster's sub-resource ARNs.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.DescribeAccessEntryHttp)`.
 * @binding
 * @section Inspecting Identity and Access
 * @example Read an Access Entry
 * ```typescript
 * // init
 * const describeAccessEntry = yield* AWS.EKS.DescribeAccessEntry(cluster);
 *
 * // runtime
 * const { accessEntry } = yield* describeAccessEntry({ principalArn });
 * ```
 */
export interface DescribeAccessEntry extends Binding.Service<
  DescribeAccessEntry,
  "AWS.EKS.DescribeAccessEntry",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: Omit<eks.DescribeAccessEntryRequest, "clusterName">,
    ) => Effect.Effect<
      eks.DescribeAccessEntryResponse,
      eks.DescribeAccessEntryError
    >
  >
> {}
export const DescribeAccessEntry = Binding.Service<DescribeAccessEntry>(
  "AWS.EKS.DescribeAccessEntry",
);
