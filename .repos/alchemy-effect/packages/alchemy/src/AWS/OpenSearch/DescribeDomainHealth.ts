import type * as opensearch from "@distilled.cloud/aws/opensearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeDomainHealth` operation (IAM action
 * `es:DescribeDomainHealth`).
 *
 * Reads a domain's cluster health — overall status, master eligibility, per-AZ shard and node distribution — for dashboards and automated health checks. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.DescribeDomainHealthHttp)`.
 * @binding
 * @section Monitoring Domains
 * @example Check Cluster Health
 * ```typescript
 * const describeDomainHealth = yield* OpenSearch.DescribeDomainHealth();
 *
 * const result = yield* describeDomainHealth({ DomainName: name });
 * // result.ClusterHealth → "Green"
 * ```
 */
export interface DescribeDomainHealth extends Binding.Service<
  DescribeDomainHealth,
  "AWS.OpenSearch.DescribeDomainHealth",
  () => Effect.Effect<
    (
      request: opensearch.DescribeDomainHealthRequest,
    ) => Effect.Effect<
      opensearch.DescribeDomainHealthResponse,
      opensearch.DescribeDomainHealthError
    >
  >
> {}
export const DescribeDomainHealth = Binding.Service<DescribeDomainHealth>(
  "AWS.OpenSearch.DescribeDomainHealth",
);
