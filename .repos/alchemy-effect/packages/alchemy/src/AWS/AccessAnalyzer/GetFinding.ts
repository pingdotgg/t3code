import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Analyzer } from "./Analyzer.ts";

/** `GetFinding` request with `analyzerArn` injected from the bound {@link Analyzer}. */
export interface GetFindingRequest extends Omit<
  aa.GetFindingRequest,
  "analyzerArn"
> {}

/**
 * Runtime binding for `access-analyzer:GetFinding`.
 *
 * Retrieves a single external-access finding (V1 API — prefer {@link
 * GetFindingV2}). Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.GetFindingHttp)`.
 * ### Reading Findings
 * **Example:** Get a Finding by Id (V1)
 * ```typescript
 * const getFinding = yield* AWS.AccessAnalyzer.GetFinding(analyzer);
 * const result = yield* getFinding({ id: findingId });
 * ```
 *
 * @binding
 */
export interface GetFinding extends Binding.Service<
  GetFinding,
  "AWS.AccessAnalyzer.GetFinding",
  (
    analyzer: Analyzer,
  ) => Effect.Effect<
    (
      request: GetFindingRequest,
    ) => Effect.Effect<aa.GetFindingResponse, aa.GetFindingError>
  >
> {}

export const GetFinding = Binding.Service<GetFinding>(
  "AWS.AccessAnalyzer.GetFinding",
);
