import type * as opensearch from "@distilled.cloud/aws/opensearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeDomain` operation (IAM action
 * `es:DescribeDomain`).
 *
 * Reads a domain's current status — endpoint, engine version, creation and processing state — e.g. an operational health check that verifies a domain is active before routing search traffic. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.DescribeDomainHttp)`.
 * @binding
 * @section Monitoring Domains
 * @example Check a Domain's Status
 * ```typescript
 * const describeDomain = yield* OpenSearch.DescribeDomain();
 *
 * const result = yield* describeDomain({ DomainName: name });
 * // result.DomainStatus.Processing → false
 * ```
 */
export interface DescribeDomain extends Binding.Service<
  DescribeDomain,
  "AWS.OpenSearch.DescribeDomain",
  () => Effect.Effect<
    (
      request: opensearch.DescribeDomainRequest,
    ) => Effect.Effect<
      opensearch.DescribeDomainResponse,
      opensearch.DescribeDomainError
    >
  >
> {}
export const DescribeDomain = Binding.Service<DescribeDomain>(
  "AWS.OpenSearch.DescribeDomain",
);
