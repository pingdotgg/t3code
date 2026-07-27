import type * as SVC from "@distilled.cloud/aws/codepipeline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipeline } from "./Pipeline.ts";

export interface ListRuleExecutionsRequest extends Omit<
  SVC.ListRuleExecutionsInput,
  "pipelineName"
> {}

/**
 * Runtime binding for `codepipeline:ListRuleExecutions` — enumerates the
 * execution history of stage-condition rules (V2 pipelines).
 * @binding
 * @section Observing Pipelines
 * @example List Rule Executions
 * ```typescript
 * const listRules = yield* AWS.CodePipeline.ListRuleExecutions(pipeline);
 *
 * const { ruleExecutionDetails } = yield* listRules();
 * ```
 */
export interface ListRuleExecutions extends Binding.Service<
  ListRuleExecutions,
  "AWS.CodePipeline.ListRuleExecutions",
  <P extends Pipeline>(
    pipeline: P,
  ) => Effect.Effect<
    (
      request?: ListRuleExecutionsRequest,
    ) => Effect.Effect<
      SVC.ListRuleExecutionsOutput,
      SVC.ListRuleExecutionsError
    >
  >
> {}
export const ListRuleExecutions = Binding.Service<ListRuleExecutions>(
  "AWS.CodePipeline.ListRuleExecutions",
);
