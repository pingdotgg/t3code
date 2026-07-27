import type * as opensearch from "@distilled.cloud/aws/opensearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeDomainAutoTunes` operation (IAM action
 * `es:DescribeDomainAutoTunes`).
 *
 * Lists the Auto-Tune optimizations scheduled for a domain — e.g. to surface upcoming JVM heap or queue tuning actions to operators. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.DescribeDomainAutoTunesHttp)`.
 * @binding
 * @section Auto-Tune and Scheduled Actions
 * @example List Scheduled Auto-Tune Optimizations
 * ```typescript
 * const describeDomainAutoTunes = yield* OpenSearch.DescribeDomainAutoTunes();
 *
 * const result = yield* describeDomainAutoTunes({ DomainName: name });
 * // result.AutoTunes → scheduled optimizations
 * ```
 */
export interface DescribeDomainAutoTunes extends Binding.Service<
  DescribeDomainAutoTunes,
  "AWS.OpenSearch.DescribeDomainAutoTunes",
  () => Effect.Effect<
    (
      request: opensearch.DescribeDomainAutoTunesRequest,
    ) => Effect.Effect<
      opensearch.DescribeDomainAutoTunesResponse,
      opensearch.DescribeDomainAutoTunesError
    >
  >
> {}
export const DescribeDomainAutoTunes = Binding.Service<DescribeDomainAutoTunes>(
  "AWS.OpenSearch.DescribeDomainAutoTunes",
);
