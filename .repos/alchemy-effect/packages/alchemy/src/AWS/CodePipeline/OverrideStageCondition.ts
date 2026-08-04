import type * as SVC from "@distilled.cloud/aws/codepipeline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipeline } from "./Pipeline.ts";

export interface OverrideStageConditionRequest extends Omit<
  SVC.OverrideStageConditionInput,
  "pipelineName"
> {}

/**
 * Runtime binding for `codepipeline:OverrideStageCondition` — overrides a
 * stage condition (e.g. a failing `BEFORE_ENTRY` or `ON_SUCCESS` check) so
 * the execution can proceed (V2 pipelines).
 * @binding
 * @section Operating Stages
 * @example Override a Failing Entry Condition
 * ```typescript
 * const overrideCondition =
 *   yield* AWS.CodePipeline.OverrideStageCondition(pipeline);
 *
 * yield* overrideCondition({
 *   stageName: "Deploy",
 *   pipelineExecutionId: executionId,
 *   conditionType: "BEFORE_ENTRY",
 * });
 * ```
 */
export interface OverrideStageCondition extends Binding.Service<
  OverrideStageCondition,
  "AWS.CodePipeline.OverrideStageCondition",
  <P extends Pipeline>(
    pipeline: P,
  ) => Effect.Effect<
    (
      request: OverrideStageConditionRequest,
    ) => Effect.Effect<
      SVC.OverrideStageConditionResponse,
      SVC.OverrideStageConditionError
    >
  >
> {}
export const OverrideStageCondition = Binding.Service<OverrideStageCondition>(
  "AWS.CodePipeline.OverrideStageCondition",
);
