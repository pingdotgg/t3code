import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:ListIdentityProviderConfigs`.
 *
 * Enumerates the OIDC identity provider configurations associated with the bound cluster.
 * The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:ListIdentityProviderConfigs` is granted on the cluster's ARN.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.ListIdentityProviderConfigsHttp)`.
 * @binding
 * @section Identity Provider Configs
 * @example List OIDC Identity Provider Configs
 * ```typescript
 * // init
 * const listIdentityProviderConfigs =
 *   yield* AWS.EKS.ListIdentityProviderConfigs(cluster);
 *
 * // runtime
 * const { identityProviderConfigs } = yield* listIdentityProviderConfigs();
 * ```
 */
export interface ListIdentityProviderConfigs extends Binding.Service<
  ListIdentityProviderConfigs,
  "AWS.EKS.ListIdentityProviderConfigs",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: Omit<eks.ListIdentityProviderConfigsRequest, "clusterName">,
    ) => Effect.Effect<
      eks.ListIdentityProviderConfigsResponse,
      eks.ListIdentityProviderConfigsError
    >
  >
> {}
export const ListIdentityProviderConfigs =
  Binding.Service<ListIdentityProviderConfigs>(
    "AWS.EKS.ListIdentityProviderConfigs",
  );
