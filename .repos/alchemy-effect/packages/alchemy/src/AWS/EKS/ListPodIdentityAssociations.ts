import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:ListPodIdentityAssociations`.
 *
 * Enumerates the EKS Pod Identity associations on the bound cluster, optionally filtered by namespace or service account.
 * The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:ListPodIdentityAssociations` is granted on the cluster's ARN.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.ListPodIdentityAssociationsHttp)`.
 * @binding
 * @section Inspecting Identity and Access
 * @example List Pod Identity Associations in a Namespace
 * ```typescript
 * // init
 * const listPodIdentityAssociations =
 *   yield* AWS.EKS.ListPodIdentityAssociations(cluster);
 *
 * // runtime
 * const { associations } = yield* listPodIdentityAssociations({
 *   namespace: "default",
 * });
 * ```
 */
export interface ListPodIdentityAssociations extends Binding.Service<
  ListPodIdentityAssociations,
  "AWS.EKS.ListPodIdentityAssociations",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: Omit<eks.ListPodIdentityAssociationsRequest, "clusterName">,
    ) => Effect.Effect<
      eks.ListPodIdentityAssociationsResponse,
      eks.ListPodIdentityAssociationsError
    >
  >
> {}
export const ListPodIdentityAssociations =
  Binding.Service<ListPodIdentityAssociations>(
    "AWS.EKS.ListPodIdentityAssociations",
  );
