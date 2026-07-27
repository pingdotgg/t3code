import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Analyzer } from "./Analyzer.ts";

/** `GetAnalyzedResource` request with `analyzerArn` injected from the bound {@link Analyzer}. */
export interface GetAnalyzedResourceRequest extends Omit<
  aa.GetAnalyzedResourceRequest,
  "analyzerArn"
> {}

/**
 * Runtime binding for `access-analyzer:GetAnalyzedResource`.
 *
 * Retrieves the analysis status and sharing summary for a resource the
 * analyzer has scanned. Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.GetAnalyzedResourceHttp)`.
 * @binding
 * @section Scanning Resources
 * @example Inspect an Analyzed Resource
 * ```typescript
 * const getResource =
 *   yield* AWS.AccessAnalyzer.GetAnalyzedResource(analyzer);
 * const analyzed = yield* getResource({ resourceArn: bucket.bucketArn });
 * ```
 */
export interface GetAnalyzedResource extends Binding.Service<
  GetAnalyzedResource,
  "AWS.AccessAnalyzer.GetAnalyzedResource",
  (
    analyzer: Analyzer,
  ) => Effect.Effect<
    (
      request: GetAnalyzedResourceRequest,
    ) => Effect.Effect<
      aa.GetAnalyzedResourceResponse,
      aa.GetAnalyzedResourceError
    >
  >
> {}

export const GetAnalyzedResource = Binding.Service<GetAnalyzedResource>(
  "AWS.AccessAnalyzer.GetAnalyzedResource",
);
