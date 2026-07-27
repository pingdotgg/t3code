import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Analyzer } from "./Analyzer.ts";

/** `ListFindingsV2` request with `analyzerArn` injected from the bound {@link Analyzer}. */
export interface ListFindingsV2Request extends Omit<
  aa.ListFindingsV2Request,
  "analyzerArn"
> {}

/**
 * Runtime binding for the `ListFindingsV2` operation (IAM action
 * `access-analyzer:ListFindings` — shared with the V1 API).
 *
 * Lists the analyzer's findings (external-access and unused-access), with
 * optional filter and sort criteria. Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.ListFindingsV2Http)`.
 * @binding
 * @section Reading Findings
 * @example List Active Findings
 * ```typescript
 * // init — bind the operation to the analyzer
 * const listFindings = yield* AWS.AccessAnalyzer.ListFindingsV2(analyzer);
 *
 * // runtime — page through active findings
 * const page = yield* listFindings({
 *   filter: { status: { eq: ["ACTIVE"] } },
 *   maxResults: 50,
 * });
 * ```
 */
export interface ListFindingsV2 extends Binding.Service<
  ListFindingsV2,
  "AWS.AccessAnalyzer.ListFindingsV2",
  (
    analyzer: Analyzer,
  ) => Effect.Effect<
    (
      request?: ListFindingsV2Request,
    ) => Effect.Effect<aa.ListFindingsV2Response, aa.ListFindingsV2Error>
  >
> {}

export const ListFindingsV2 = Binding.Service<ListFindingsV2>(
  "AWS.AccessAnalyzer.ListFindingsV2",
);
