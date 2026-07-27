import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:GetManagedScalingPolicy` — reads the bound cluster's managed scaling policy (compute limits), if one is attached.
 * @binding
 * @section Scaling the Cluster
 * @example Read the Scaling Limits
 * ```typescript
 * const getScalingPolicy = yield* AWS.EMR.GetManagedScalingPolicy(cluster);
 *
 * const { ManagedScalingPolicy } = yield* getScalingPolicy();
 * ```
 */
export interface GetManagedScalingPolicy extends Binding.Service<
  GetManagedScalingPolicy,
  "AWS.EMR.GetManagedScalingPolicy",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.GetManagedScalingPolicyInput, "ClusterId">,
    ) => Effect.Effect<
      SVC.GetManagedScalingPolicyOutput,
      SVC.GetManagedScalingPolicyError
    >
  >
> {}
export const GetManagedScalingPolicy = Binding.Service<GetManagedScalingPolicy>(
  "AWS.EMR.GetManagedScalingPolicy",
);
