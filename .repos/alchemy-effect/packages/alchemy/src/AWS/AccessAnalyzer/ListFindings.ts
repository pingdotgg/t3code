import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Analyzer } from "./Analyzer.ts";

/** `ListFindings` request with `analyzerArn` injected from the bound {@link Analyzer}. */
export interface ListFindingsRequest extends Omit<
  aa.ListFindingsRequest,
  "analyzerArn"
> {}

/**
 * Runtime binding for `access-analyzer:ListFindings`.
 *
 * Lists the analyzer's external-access findings (V1 API — prefer {@link
 * ListFindingsV2}, which also returns unused-access findings). Provide the
 * implementation with `Effect.provide(AWS.AccessAnalyzer.ListFindingsHttp)`.
 * @binding
 * @section Reading Findings
 * @example List Findings (V1)
 * ```typescript
 * const listFindings = yield* AWS.AccessAnalyzer.ListFindings(analyzer);
 * const page = yield* listFindings({ maxResults: 50 });
 * ```
 */
export interface ListFindings extends Binding.Service<
  ListFindings,
  "AWS.AccessAnalyzer.ListFindings",
  (
    analyzer: Analyzer,
  ) => Effect.Effect<
    (
      request?: ListFindingsRequest,
    ) => Effect.Effect<aa.ListFindingsResponse, aa.ListFindingsError>
  >
> {}

export const ListFindings = Binding.Service<ListFindings>(
  "AWS.AccessAnalyzer.ListFindings",
);
