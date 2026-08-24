import type * as sfn from "@distilled.cloud/aws/sfn";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { StateMachine } from "./StateMachine.ts";

export interface StopExecutionRequest extends sfn.StopExecutionInput {}

/**
 * Runtime binding for `states:StopExecution`.
 *
 * Bind this operation to a {@link StateMachine} inside a function runtime to
 * cancel that machine's running executions. Not supported by `EXPRESS`
 * workflows.
 * @binding
 * @section Stopping Executions
 * @example Cancel a running execution
 * ```typescript
 * const stopExecution = yield* StepFunctions.StopExecution(machine);
 *
 * yield* stopExecution({
 *   executionArn,
 *   error: "OrderCancelled",
 *   cause: "user requested cancellation",
 * });
 * ```
 */
export interface StopExecution extends Binding.Service<
  StopExecution,
  "AWS.StepFunctions.StopExecution",
  (
    stateMachine: StateMachine,
  ) => Effect.Effect<
    (
      request: StopExecutionRequest,
    ) => Effect.Effect<sfn.StopExecutionOutput, sfn.StopExecutionError>
  >
> {}
export const StopExecution = Binding.Service<StopExecution>(
  "AWS.StepFunctions.StopExecution",
);
