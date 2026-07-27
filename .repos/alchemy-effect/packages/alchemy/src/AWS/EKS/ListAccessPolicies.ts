import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `eks:ListAccessPolicies`.
 *
 * Enumerates the AWS-managed EKS access policies (`AmazonEKSAdminPolicy`, `AmazonEKSViewPolicy`, …) that can be associated with access entries.
 * `eks:ListAccessPolicies` is granted on `*` — the operation is account-scoped and takes no resource.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.ListAccessPoliciesHttp)`.
 * @binding
 * @section Discovering Clusters
 * @example List the Managed Access Policies
 * ```typescript
 * // init
 * const listAccessPolicies = yield* AWS.EKS.ListAccessPolicies();
 *
 * // runtime
 * const { accessPolicies } = yield* listAccessPolicies();
 * ```
 */
export interface ListAccessPolicies extends Binding.Service<
  ListAccessPolicies,
  "AWS.EKS.ListAccessPolicies",
  () => Effect.Effect<
    (
      request?: eks.ListAccessPoliciesRequest,
    ) => Effect.Effect<
      eks.ListAccessPoliciesResponse,
      eks.ListAccessPoliciesError
    >
  >
> {}
export const ListAccessPolicies = Binding.Service<ListAccessPolicies>(
  "AWS.EKS.ListAccessPolicies",
);
