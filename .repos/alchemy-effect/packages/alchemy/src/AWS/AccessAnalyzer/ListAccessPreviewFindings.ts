import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Analyzer } from "./Analyzer.ts";

/** `ListAccessPreviewFindings` request with `analyzerArn` injected from the bound {@link Analyzer}. */
export interface ListAccessPreviewFindingsRequest extends Omit<
  aa.ListAccessPreviewFindingsRequest,
  "analyzerArn"
> {}

/**
 * Runtime binding for `access-analyzer:ListAccessPreviewFindings`.
 *
 * Lists the findings a completed access preview produced. Provide the
 * implementation with
 * `Effect.provide(AWS.AccessAnalyzer.ListAccessPreviewFindingsHttp)`.
 * @binding
 * @section Access Previews
 * @example Read Preview Findings
 * ```typescript
 * const listPreviewFindings =
 *   yield* AWS.AccessAnalyzer.ListAccessPreviewFindings(analyzer);
 * const page = yield* listPreviewFindings({ accessPreviewId });
 * ```
 */
export interface ListAccessPreviewFindings extends Binding.Service<
  ListAccessPreviewFindings,
  "AWS.AccessAnalyzer.ListAccessPreviewFindings",
  (
    analyzer: Analyzer,
  ) => Effect.Effect<
    (
      request: ListAccessPreviewFindingsRequest,
    ) => Effect.Effect<
      aa.ListAccessPreviewFindingsResponse,
      aa.ListAccessPreviewFindingsError
    >
  >
> {}

export const ListAccessPreviewFindings =
  Binding.Service<ListAccessPreviewFindings>(
    "AWS.AccessAnalyzer.ListAccessPreviewFindings",
  );
