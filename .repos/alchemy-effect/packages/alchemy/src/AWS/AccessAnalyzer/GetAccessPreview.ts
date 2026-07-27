import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Analyzer } from "./Analyzer.ts";

/** `GetAccessPreview` request with `analyzerArn` injected from the bound {@link Analyzer}. */
export interface GetAccessPreviewRequest extends Omit<
  aa.GetAccessPreviewRequest,
  "analyzerArn"
> {}

/**
 * Runtime binding for `access-analyzer:GetAccessPreview`.
 *
 * Retrieves an access preview's status and configuration. Provide the
 * implementation with
 * `Effect.provide(AWS.AccessAnalyzer.GetAccessPreviewHttp)`.
 * @binding
 * @section Access Previews
 * @example Poll a Preview Until Completed
 * ```typescript
 * const getPreview = yield* AWS.AccessAnalyzer.GetAccessPreview(analyzer);
 * const preview = yield* getPreview({ accessPreviewId });
 * ```
 */
export interface GetAccessPreview extends Binding.Service<
  GetAccessPreview,
  "AWS.AccessAnalyzer.GetAccessPreview",
  (
    analyzer: Analyzer,
  ) => Effect.Effect<
    (
      request: GetAccessPreviewRequest,
    ) => Effect.Effect<aa.GetAccessPreviewResponse, aa.GetAccessPreviewError>
  >
> {}

export const GetAccessPreview = Binding.Service<GetAccessPreview>(
  "AWS.AccessAnalyzer.GetAccessPreview",
);
