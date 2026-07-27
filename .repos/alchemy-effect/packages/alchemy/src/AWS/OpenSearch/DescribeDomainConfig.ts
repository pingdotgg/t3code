import type * as opensearch from "@distilled.cloud/aws/opensearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeDomainConfig` operation (IAM action
 * `es:DescribeDomainConfig`).
 *
 * Reads a domain's full configuration, with per-option status metadata (update date, state, pending values) — the authoritative view of what a blue/green change is converging toward. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.DescribeDomainConfigHttp)`.
 * @binding
 * @section Monitoring Domains
 * @example Read a Domain's Configuration
 * ```typescript
 * const describeDomainConfig = yield* OpenSearch.DescribeDomainConfig();
 *
 * const result = yield* describeDomainConfig({ DomainName: name });
 * // result.DomainConfig.ClusterConfig?.Status.State → "Active"
 * ```
 */
export interface DescribeDomainConfig extends Binding.Service<
  DescribeDomainConfig,
  "AWS.OpenSearch.DescribeDomainConfig",
  () => Effect.Effect<
    (
      request: opensearch.DescribeDomainConfigRequest,
    ) => Effect.Effect<
      opensearch.DescribeDomainConfigResponse,
      opensearch.DescribeDomainConfigError
    >
  >
> {}
export const DescribeDomainConfig = Binding.Service<DescribeDomainConfig>(
  "AWS.OpenSearch.DescribeDomainConfig",
);
