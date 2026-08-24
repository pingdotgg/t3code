import type * as emrc from "@distilled.cloud/aws/emr-containers";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { VirtualCluster } from "./VirtualCluster.ts";

/**
 * Runtime binding for `emr-containers:DescribeVirtualCluster`.
 *
 * Reads the bound {@link VirtualCluster}'s live state — its lifecycle state
 * (`RUNNING`/`TERMINATING`/`TERMINATED`/`ARRESTED`), the backing EKS
 * container provider, and the attached security configuration. The virtual
 * cluster ID is injected from the binding — the runtime callable takes no
 * arguments. Provide the implementation with
 * `Effect.provide(AWS.EMRContainers.DescribeVirtualClusterHttp)`.
 * @binding
 * @section Virtual Clusters
 * @example Read The Bound Virtual Cluster
 * ```typescript
 * // init — bind the operation to the virtual cluster
 * const describeVirtualCluster =
 *   yield* AWS.EMRContainers.DescribeVirtualCluster(virtualCluster);
 *
 * // runtime
 * const { virtualCluster } = yield* describeVirtualCluster();
 * yield* Effect.log(`virtual cluster is ${virtualCluster?.state}`);
 * ```
 */
export interface DescribeVirtualCluster extends Binding.Service<
  DescribeVirtualCluster,
  "AWS.EMRContainers.DescribeVirtualCluster",
  (
    virtualCluster: VirtualCluster,
  ) => Effect.Effect<
    () => Effect.Effect<
      emrc.DescribeVirtualClusterResponse,
      emrc.DescribeVirtualClusterError
    >
  >
> {}
export const DescribeVirtualCluster = Binding.Service<DescribeVirtualCluster>(
  "AWS.EMRContainers.DescribeVirtualCluster",
);
