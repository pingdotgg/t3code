import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:DescribeUpdate`.
 *
 * Reads one update's status and parameters — poll it to track an in-flight version upgrade or config change.
 * The cluster `name` is injected from the bound {@link Cluster} and `eks:DescribeUpdate` is granted on the cluster's ARN and sub-resource ARNs.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.DescribeUpdateHttp)`.
 * @binding
 * @section Tracking Updates
 * @example Poll an Update's Status
 * ```typescript
 * // init
 * const describeUpdate = yield* AWS.EKS.DescribeUpdate(cluster);
 *
 * // runtime
 * const { update } = yield* describeUpdate({ updateId });
 * const done = update?.status === "Successful";
 * ```
 */
export interface DescribeUpdate extends Binding.Service<
  DescribeUpdate,
  "AWS.EKS.DescribeUpdate",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: Omit<eks.DescribeUpdateRequest, "name">,
    ) => Effect.Effect<eks.DescribeUpdateResponse, eks.DescribeUpdateError>
  >
> {}
export const DescribeUpdate = Binding.Service<DescribeUpdate>(
  "AWS.EKS.DescribeUpdate",
);
