import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Analyzer } from "./Analyzer.ts";

/** `StartResourceScan` request with `analyzerArn` injected from the bound {@link Analyzer}. */
export interface StartResourceScanRequest extends Omit<
  aa.StartResourceScanRequest,
  "analyzerArn"
> {}

/**
 * Runtime binding for `access-analyzer:StartResourceScan`.
 *
 * Immediately rescans a resource's policy instead of waiting for the
 * analyzer's periodic scan. Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.StartResourceScanHttp)`.
 * @binding
 * @section Scanning Resources
 * @example Rescan a Bucket After a Policy Change
 * ```typescript
 * const startScan = yield* AWS.AccessAnalyzer.StartResourceScan(analyzer);
 * yield* startScan({ resourceArn: bucket.bucketArn });
 * ```
 */
export interface StartResourceScan extends Binding.Service<
  StartResourceScan,
  "AWS.AccessAnalyzer.StartResourceScan",
  (
    analyzer: Analyzer,
  ) => Effect.Effect<
    (
      request: StartResourceScanRequest,
    ) => Effect.Effect<aa.StartResourceScanResponse, aa.StartResourceScanError>
  >
> {}

export const StartResourceScan = Binding.Service<StartResourceScan>(
  "AWS.AccessAnalyzer.StartResourceScan",
);
