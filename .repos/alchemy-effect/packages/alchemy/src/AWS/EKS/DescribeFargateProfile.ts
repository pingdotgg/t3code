import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:DescribeFargateProfile`.
 *
 * Reads one Fargate profile's state — pod execution role, selectors, subnets, and status.
 * The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:DescribeFargateProfile` is granted on the cluster's sub-resource ARNs.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.DescribeFargateProfileHttp)`.
 * @binding
 * @section Inspecting Compute
 * @example Read a Fargate Profile
 * ```typescript
 * // init
 * const describeFargateProfile = yield* AWS.EKS.DescribeFargateProfile(cluster);
 *
 * // runtime
 * const { fargateProfile } = yield* describeFargateProfile({
 *   fargateProfileName: "default",
 * });
 * ```
 */
export interface DescribeFargateProfile extends Binding.Service<
  DescribeFargateProfile,
  "AWS.EKS.DescribeFargateProfile",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: Omit<eks.DescribeFargateProfileRequest, "clusterName">,
    ) => Effect.Effect<
      eks.DescribeFargateProfileResponse,
      eks.DescribeFargateProfileError
    >
  >
> {}
export const DescribeFargateProfile = Binding.Service<DescribeFargateProfile>(
  "AWS.EKS.DescribeFargateProfile",
);
