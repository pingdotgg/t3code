import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:ListNodegroups`.
 *
 * Enumerates the managed node group names attached to the bound cluster.
 * The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:ListNodegroups` is granted on the cluster's ARN.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.ListNodegroupsHttp)`.
 * @binding
 * @section Inspecting Compute
 * @example List the Cluster's Node Groups
 * ```typescript
 * // init
 * const listNodegroups = yield* AWS.EKS.ListNodegroups(cluster);
 *
 * // runtime
 * const { nodegroups } = yield* listNodegroups();
 * ```
 */
export interface ListNodegroups extends Binding.Service<
  ListNodegroups,
  "AWS.EKS.ListNodegroups",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: Omit<eks.ListNodegroupsRequest, "clusterName">,
    ) => Effect.Effect<eks.ListNodegroupsResponse, eks.ListNodegroupsError>
  >
> {}
export const ListNodegroups = Binding.Service<ListNodegroups>(
  "AWS.EKS.ListNodegroups",
);
