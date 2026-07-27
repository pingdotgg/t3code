import type * as opensearch from "@distilled.cloud/aws/opensearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeDomainChangeProgress` operation (IAM action
 * `es:DescribeDomainChangeProgress`).
 *
 * Tracks the stage-by-stage progress of a domain's in-flight configuration change (blue/green deployment) — e.g. to report how far along a cluster resize is. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.DescribeDomainChangeProgressHttp)`.
 * @binding
 * @section Monitoring Domains
 * @example Track a Configuration Change
 * ```typescript
 * const describeDomainChangeProgress = yield* OpenSearch.DescribeDomainChangeProgress();
 *
 * const result = yield* describeDomainChangeProgress({ DomainName: name });
 * // result.ChangeProgressStatus?.Status → "COMPLETED"
 * ```
 */
export interface DescribeDomainChangeProgress extends Binding.Service<
  DescribeDomainChangeProgress,
  "AWS.OpenSearch.DescribeDomainChangeProgress",
  () => Effect.Effect<
    (
      request: opensearch.DescribeDomainChangeProgressRequest,
    ) => Effect.Effect<
      opensearch.DescribeDomainChangeProgressResponse,
      opensearch.DescribeDomainChangeProgressError
    >
  >
> {}
export const DescribeDomainChangeProgress =
  Binding.Service<DescribeDomainChangeProgress>(
    "AWS.OpenSearch.DescribeDomainChangeProgress",
  );
