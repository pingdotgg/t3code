import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:ListCapabilities`.
 *
 * Enumerates the managed capabilities (e.g. Argo CD) installed on the bound cluster.
 * The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:ListCapabilities` is granted on the cluster's ARN.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.ListCapabilitiesHttp)`.
 * @binding
 * @section Cluster Capabilities
 * @example List Installed Capabilities
 * ```typescript
 * // init
 * const listCapabilities = yield* AWS.EKS.ListCapabilities(cluster);
 *
 * // runtime
 * const { capabilities } = yield* listCapabilities();
 * ```
 */
export interface ListCapabilities extends Binding.Service<
  ListCapabilities,
  "AWS.EKS.ListCapabilities",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: Omit<eks.ListCapabilitiesRequest, "clusterName">,
    ) => Effect.Effect<eks.ListCapabilitiesResponse, eks.ListCapabilitiesError>
  >
> {}
export const ListCapabilities = Binding.Service<ListCapabilities>(
  "AWS.EKS.ListCapabilities",
);
