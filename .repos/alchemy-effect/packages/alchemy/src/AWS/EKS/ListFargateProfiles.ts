import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:ListFargateProfiles`.
 *
 * Enumerates the Fargate profile names configured on the bound cluster.
 * The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:ListFargateProfiles` is granted on the cluster's ARN.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.ListFargateProfilesHttp)`.
 * @binding
 * @section Inspecting Compute
 * @example List Fargate Profiles
 * ```typescript
 * // init
 * const listFargateProfiles = yield* AWS.EKS.ListFargateProfiles(cluster);
 *
 * // runtime
 * const { fargateProfileNames } = yield* listFargateProfiles();
 * ```
 */
export interface ListFargateProfiles extends Binding.Service<
  ListFargateProfiles,
  "AWS.EKS.ListFargateProfiles",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: Omit<eks.ListFargateProfilesRequest, "clusterName">,
    ) => Effect.Effect<
      eks.ListFargateProfilesResponse,
      eks.ListFargateProfilesError
    >
  >
> {}
export const ListFargateProfiles = Binding.Service<ListFargateProfiles>(
  "AWS.EKS.ListFargateProfiles",
);
