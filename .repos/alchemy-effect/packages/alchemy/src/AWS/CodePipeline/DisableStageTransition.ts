import type * as SVC from "@distilled.cloud/aws/codepipeline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipeline } from "./Pipeline.ts";

export interface DisableStageTransitionRequest extends Omit<
  SVC.DisableStageTransitionInput,
  "pipelineName"
> {}

/**
 * Runtime binding for `codepipeline:DisableStageTransition` — freezes a
 * transition into (`Inbound`) or out of (`Outbound`) a stage, e.g. to gate
 * deploys during an incident.
 * @binding
 * @section Operating Stages
 * @example Freeze Deploys
 * ```typescript
 * const disableTransition =
 *   yield* AWS.CodePipeline.DisableStageTransition(pipeline);
 *
 * yield* disableTransition({
 *   stageName: "Deploy",
 *   transitionType: "Inbound",
 *   reason: "incident in progress",
 * });
 * ```
 */
export interface DisableStageTransition extends Binding.Service<
  DisableStageTransition,
  "AWS.CodePipeline.DisableStageTransition",
  <P extends Pipeline>(
    pipeline: P,
  ) => Effect.Effect<
    (
      request: DisableStageTransitionRequest,
    ) => Effect.Effect<
      SVC.DisableStageTransitionResponse,
      SVC.DisableStageTransitionError
    >
  >
> {}
export const DisableStageTransition = Binding.Service<DisableStageTransition>(
  "AWS.CodePipeline.DisableStageTransition",
);
