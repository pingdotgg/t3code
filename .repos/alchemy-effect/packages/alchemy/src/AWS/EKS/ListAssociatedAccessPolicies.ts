import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:ListAssociatedAccessPolicies`.
 *
 * Enumerates the EKS access policies associated with one access entry's IAM principal.
 * The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:ListAssociatedAccessPolicies` is granted on the cluster's sub-resource ARNs.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.ListAssociatedAccessPoliciesHttp)`.
 * @binding
 * @section Inspecting Identity and Access
 * @example List a Principal's Access Policies
 * ```typescript
 * // init
 * const listAssociatedAccessPolicies =
 *   yield* AWS.EKS.ListAssociatedAccessPolicies(cluster);
 *
 * // runtime
 * const { associatedAccessPolicies } = yield* listAssociatedAccessPolicies({
 *   principalArn,
 * });
 * ```
 */
export interface ListAssociatedAccessPolicies extends Binding.Service<
  ListAssociatedAccessPolicies,
  "AWS.EKS.ListAssociatedAccessPolicies",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: Omit<eks.ListAssociatedAccessPoliciesRequest, "clusterName">,
    ) => Effect.Effect<
      eks.ListAssociatedAccessPoliciesResponse,
      eks.ListAssociatedAccessPoliciesError
    >
  >
> {}
export const ListAssociatedAccessPolicies =
  Binding.Service<ListAssociatedAccessPolicies>(
    "AWS.EKS.ListAssociatedAccessPolicies",
  );
