import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Analyzer } from "./Analyzer.ts";

/** `ListAnalyzedResources` request with `analyzerArn` injected from the bound {@link Analyzer}. */
export interface ListAnalyzedResourcesRequest extends Omit<
  aa.ListAnalyzedResourcesRequest,
  "analyzerArn"
> {}

/**
 * Runtime binding for `access-analyzer:ListAnalyzedResources`.
 *
 * Lists the resources the analyzer has scanned, optionally filtered by
 * resource type. Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.ListAnalyzedResourcesHttp)`.
 * @binding
 * @section Scanning Resources
 * @example List Analyzed S3 Buckets
 * ```typescript
 * const listResources =
 *   yield* AWS.AccessAnalyzer.ListAnalyzedResources(analyzer);
 * const page = yield* listResources({
 *   resourceType: "AWS::S3::Bucket",
 * });
 * ```
 */
export interface ListAnalyzedResources extends Binding.Service<
  ListAnalyzedResources,
  "AWS.AccessAnalyzer.ListAnalyzedResources",
  (
    analyzer: Analyzer,
  ) => Effect.Effect<
    (
      request?: ListAnalyzedResourcesRequest,
    ) => Effect.Effect<
      aa.ListAnalyzedResourcesResponse,
      aa.ListAnalyzedResourcesError
    >
  >
> {}

export const ListAnalyzedResources = Binding.Service<ListAnalyzedResources>(
  "AWS.AccessAnalyzer.ListAnalyzedResources",
);
