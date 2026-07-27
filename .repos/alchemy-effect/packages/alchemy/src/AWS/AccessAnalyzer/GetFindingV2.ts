import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Analyzer } from "./Analyzer.ts";

/** `GetFindingV2` request with `analyzerArn` injected from the bound {@link Analyzer}. */
export interface GetFindingV2Request extends Omit<
  aa.GetFindingV2Request,
  "analyzerArn"
> {}

/**
 * Runtime binding for the `GetFindingV2` operation (IAM action
 * `access-analyzer:GetFinding` — shared with the V1 API).
 *
 * Retrieves a single finding with its typed `findingDetails` (external-access
 * or unused-access). Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.GetFindingV2Http)`.
 * @binding
 * @section Reading Findings
 * @example Get a Finding by Id
 * ```typescript
 * const getFinding = yield* AWS.AccessAnalyzer.GetFindingV2(analyzer);
 * const finding = yield* getFinding({ id: findingId });
 * ```
 */
export interface GetFindingV2 extends Binding.Service<
  GetFindingV2,
  "AWS.AccessAnalyzer.GetFindingV2",
  (
    analyzer: Analyzer,
  ) => Effect.Effect<
    (
      request: GetFindingV2Request,
    ) => Effect.Effect<aa.GetFindingV2Response, aa.GetFindingV2Error>
  >
> {}

export const GetFindingV2 = Binding.Service<GetFindingV2>(
  "AWS.AccessAnalyzer.GetFindingV2",
);
