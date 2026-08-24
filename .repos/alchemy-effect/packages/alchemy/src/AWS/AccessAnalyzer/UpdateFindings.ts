import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Analyzer } from "./Analyzer.ts";

/** `UpdateFindings` request with `analyzerArn` injected from the bound {@link Analyzer}. */
export interface UpdateFindingsRequest extends Omit<
  aa.UpdateFindingsRequest,
  "analyzerArn"
> {}

/**
 * Runtime binding for `access-analyzer:UpdateFindings`.
 *
 * Archives or reactivates findings by id or by the resource they were
 * generated for. Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.UpdateFindingsHttp)`.
 * @binding
 * @section Managing Findings
 * @example Archive Findings
 * ```typescript
 * const updateFindings = yield* AWS.AccessAnalyzer.UpdateFindings(analyzer);
 * yield* updateFindings({ status: "ARCHIVED", ids: [findingId] });
 * ```
 */
export interface UpdateFindings extends Binding.Service<
  UpdateFindings,
  "AWS.AccessAnalyzer.UpdateFindings",
  (
    analyzer: Analyzer,
  ) => Effect.Effect<
    (
      request: UpdateFindingsRequest,
    ) => Effect.Effect<aa.UpdateFindingsResponse, aa.UpdateFindingsError>
  >
> {}

export const UpdateFindings = Binding.Service<UpdateFindings>(
  "AWS.AccessAnalyzer.UpdateFindings",
);
