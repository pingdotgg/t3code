import type * as opensearch from "@distilled.cloud/aws/opensearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeDomains` operation (IAM action
 * `es:DescribeDomains`).
 *
 * Reads the current status of up to five domains in one call — the batch form of `DescribeDomain`. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.DescribeDomainsHttp)`.
 * @binding
 * @section Monitoring Domains
 * @example Check Several Domains at Once
 * ```typescript
 * const describeDomains = yield* OpenSearch.DescribeDomains();
 *
 * const result = yield* describeDomains({ DomainNames: [a, b] });
 * // result.DomainStatusList → one status per domain
 * ```
 */
export interface DescribeDomains extends Binding.Service<
  DescribeDomains,
  "AWS.OpenSearch.DescribeDomains",
  () => Effect.Effect<
    (
      request: opensearch.DescribeDomainsRequest,
    ) => Effect.Effect<
      opensearch.DescribeDomainsResponse,
      opensearch.DescribeDomainsError
    >
  >
> {}
export const DescribeDomains = Binding.Service<DescribeDomains>(
  "AWS.OpenSearch.DescribeDomains",
);
