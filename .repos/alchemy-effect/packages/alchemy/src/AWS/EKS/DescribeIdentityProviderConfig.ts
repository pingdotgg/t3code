import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:DescribeIdentityProviderConfig`.
 *
 * Reads one OIDC identity provider configuration associated with the bound cluster — issuer URL, client ID, claim mappings, and association status.
 * The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:DescribeIdentityProviderConfig` is granted on the cluster's sub-resource ARNs.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.DescribeIdentityProviderConfigHttp)`.
 * @binding
 * @section Identity Provider Configs
 * @example Read an OIDC Identity Provider Config
 * ```typescript
 * // init
 * const describeIdentityProviderConfig =
 *   yield* AWS.EKS.DescribeIdentityProviderConfig(cluster);
 *
 * // runtime
 * const { identityProviderConfig } = yield* describeIdentityProviderConfig({
 *   identityProviderConfig: { type: "oidc", name: "corp-oidc" },
 * });
 * const issuer = identityProviderConfig?.oidc?.issuerUrl;
 * ```
 */
export interface DescribeIdentityProviderConfig extends Binding.Service<
  DescribeIdentityProviderConfig,
  "AWS.EKS.DescribeIdentityProviderConfig",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: Omit<eks.DescribeIdentityProviderConfigRequest, "clusterName">,
    ) => Effect.Effect<
      eks.DescribeIdentityProviderConfigResponse,
      eks.DescribeIdentityProviderConfigError
    >
  >
> {}
export const DescribeIdentityProviderConfig =
  Binding.Service<DescribeIdentityProviderConfig>(
    "AWS.EKS.DescribeIdentityProviderConfig",
  );
