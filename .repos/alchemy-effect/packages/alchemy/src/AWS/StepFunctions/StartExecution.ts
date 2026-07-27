import type * as sfn from "@distilled.cloud/aws/sfn";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { StateMachine } from "./StateMachine.ts";

export interface StartExecutionRequest extends Omit<
  sfn.StartExecutionInput,
  "stateMachineArn"
> {}

/**
 * Runtime binding for `states:StartExecution`.
 *
 * Bind this operation to a {@link StateMachine} inside a function runtime to
 * get a callable that starts asynchronous executions with the state machine
 * ARN injected automatically.
 * @binding
 * @section Starting Executions
 * @example Start a workflow execution
 * ```typescript
 * const startExecution = yield* StepFunctions.StartExecution(machine);
 *
 * const execution = yield* startExecution({
 *   input: JSON.stringify({ orderId: "123" }),
 * });
 * // execution.executionArn identifies the running workflow
 * ```
 *
 * @example Idempotent start via execution name
 * ```typescript
 * const execution = yield* startExecution({
 *   name: `order-${orderId}`,
 *   input: JSON.stringify({ orderId }),
 * });
 * ```
 */
export interface StartExecution extends Binding.Service<
  StartExecution,
  "AWS.StepFunctions.StartExecution",
  (
    stateMachine: StateMachine,
  ) => Effect.Effect<
    (
      request?: StartExecutionRequest,
    ) => Effect.Effect<sfn.StartExecutionOutput, sfn.StartExecutionError>
  >
> {}
export const StartExecution = Binding.Service<StartExecution>(
  "AWS.StepFunctions.StartExecution",
);
