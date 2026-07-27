import type * as SVC from "@distilled.cloud/aws/codepipeline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipeline } from "./Pipeline.ts";

export interface EnableStageTransitionRequest extends Omit<
  SVC.EnableStageTransitionInput,
  "pipelineName"
> {}

/**
 * Runtime binding for `codepipeline:EnableStageTransition` — re-opens a
 * transition into (`Inbound`) or out of (`Outbound`) a stage that was
 * previously disabled.
 * @binding
 * @section Operating Stages
 * @example Re-enable a Transition
 * ```typescript
 * const enableTransition =
 *   yield* AWS.CodePipeline.EnableStageTransition(pipeline);
 *
 * yield* enableTransition({
 *   stageName: "Deploy",
 *   transitionType: "Inbound",
 * });
 * ```
 */
export interface EnableStageTransition extends Binding.Service<
  EnableStageTransition,
  "AWS.CodePipeline.EnableStageTransition",
  <P extends Pipeline>(
    pipeline: P,
  ) => Effect.Effect<
    (
      request: EnableStageTransitionRequest,
    ) => Effect.Effect<
      SVC.EnableStageTransitionResponse,
      SVC.EnableStageTransitionError
    >
  >
> {}
export const EnableStageTransition = Binding.Service<EnableStageTransition>(
  "AWS.CodePipeline.EnableStageTransition",
);
