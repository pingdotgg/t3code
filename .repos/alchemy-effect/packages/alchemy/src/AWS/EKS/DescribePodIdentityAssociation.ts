import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:DescribePodIdentityAssociation`.
 *
 * Reads one EKS Pod Identity association — the IAM role wired to a Kubernetes service account.
 * The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:DescribePodIdentityAssociation` is granted on the cluster's sub-resource ARNs.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.DescribePodIdentityAssociationHttp)`.
 * @binding
 * @section Inspecting Identity and Access
 * @example Read a Pod Identity Association
 * ```typescript
 * // init
 * const describePodIdentityAssociation =
 *   yield* AWS.EKS.DescribePodIdentityAssociation(cluster);
 *
 * // runtime
 * const { association } = yield* describePodIdentityAssociation({
 *   associationId,
 * });
 * ```
 */
export interface DescribePodIdentityAssociation extends Binding.Service<
  DescribePodIdentityAssociation,
  "AWS.EKS.DescribePodIdentityAssociation",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: Omit<eks.DescribePodIdentityAssociationRequest, "clusterName">,
    ) => Effect.Effect<
      eks.DescribePodIdentityAssociationResponse,
      eks.DescribePodIdentityAssociationError
    >
  >
> {}
export const DescribePodIdentityAssociation =
  Binding.Service<DescribePodIdentityAssociation>(
    "AWS.EKS.DescribePodIdentityAssociation",
  );
