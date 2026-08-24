import type * as sfn from "@distilled.cloud/aws/sfn";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { StateMachine } from "./StateMachine.ts";

export interface UpdateMapRunRequest extends sfn.UpdateMapRunInput {}

/**
 * Runtime binding for `states:UpdateMapRun`.
 *
 * Adjusts a running Distributed Map Run's `maxConcurrency` and tolerated
 * failure thresholds in place. IAM access is scoped to Map Runs of the
 * bound {@link StateMachine}.
 * @binding
 * @section Distributed Map Runs
 * @example Throttle a running Map Run
 * ```typescript
 * const updateMapRun = yield* StepFunctions.UpdateMapRun(machine);
 *
 * yield* updateMapRun({ mapRunArn, maxConcurrency: 10 });
 * ```
 */
export interface UpdateMapRun extends Binding.Service<
  UpdateMapRun,
  "AWS.StepFunctions.UpdateMapRun",
  (
    stateMachine: StateMachine,
  ) => Effect.Effect<
    (
      request: UpdateMapRunRequest,
    ) => Effect.Effect<sfn.UpdateMapRunOutput, sfn.UpdateMapRunError>
  >
> {}
export const UpdateMapRun = Binding.Service<UpdateMapRun>(
  "AWS.StepFunctions.UpdateMapRun",
);
