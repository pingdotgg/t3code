import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Analyzer } from "./Analyzer.ts";

/** `ListAccessPreviews` request with `analyzerArn` injected from the bound {@link Analyzer}. */
export interface ListAccessPreviewsRequest extends Omit<
  aa.ListAccessPreviewsRequest,
  "analyzerArn"
> {}

/**
 * Runtime binding for `access-analyzer:ListAccessPreviews`.
 *
 * Lists the analyzer's access previews. Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.ListAccessPreviewsHttp)`.
 * @binding
 * @section Access Previews
 * @example List Access Previews
 * ```typescript
 * const listPreviews =
 *   yield* AWS.AccessAnalyzer.ListAccessPreviews(analyzer);
 * const page = yield* listPreviews();
 * ```
 */
export interface ListAccessPreviews extends Binding.Service<
  ListAccessPreviews,
  "AWS.AccessAnalyzer.ListAccessPreviews",
  (
    analyzer: Analyzer,
  ) => Effect.Effect<
    (
      request?: ListAccessPreviewsRequest,
    ) => Effect.Effect<
      aa.ListAccessPreviewsResponse,
      aa.ListAccessPreviewsError
    >
  >
> {}

export const ListAccessPreviews = Binding.Service<ListAccessPreviews>(
  "AWS.AccessAnalyzer.ListAccessPreviews",
);
