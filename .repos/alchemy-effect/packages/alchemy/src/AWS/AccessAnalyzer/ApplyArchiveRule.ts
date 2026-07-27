import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Analyzer } from "./Analyzer.ts";

/** `ApplyArchiveRule` request with `analyzerArn` injected from the bound {@link Analyzer}. */
export interface ApplyArchiveRuleRequest extends Omit<
  aa.ApplyArchiveRuleRequest,
  "analyzerArn"
> {}

/**
 * Runtime binding for `access-analyzer:ApplyArchiveRule`.
 *
 * Retroactively applies an archive rule to the analyzer's existing findings.
 * Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.ApplyArchiveRuleHttp)`.
 * @binding
 * @section Managing Findings
 * @example Apply an Archive Rule to Existing Findings
 * ```typescript
 * const applyRule = yield* AWS.AccessAnalyzer.ApplyArchiveRule(analyzer);
 * yield* applyRule({ ruleName: rule.ruleName });
 * ```
 */
export interface ApplyArchiveRule extends Binding.Service<
  ApplyArchiveRule,
  "AWS.AccessAnalyzer.ApplyArchiveRule",
  (
    analyzer: Analyzer,
  ) => Effect.Effect<
    (
      request: ApplyArchiveRuleRequest,
    ) => Effect.Effect<aa.ApplyArchiveRuleResponse, aa.ApplyArchiveRuleError>
  >
> {}

export const ApplyArchiveRule = Binding.Service<ApplyArchiveRule>(
  "AWS.AccessAnalyzer.ApplyArchiveRule",
);
