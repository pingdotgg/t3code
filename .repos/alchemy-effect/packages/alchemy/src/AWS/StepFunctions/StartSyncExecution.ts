import type * as sfn from "@distilled.cloud/aws/sfn";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { StateMachine } from "./StateMachine.ts";

export interface StartSyncExecutionRequest extends Omit<
  sfn.StartSyncExecutionInput,
  "stateMachineArn"
> {}

/**
 * Runtime binding for `states:StartSyncExecution`.
 *
 * Bind this operation to an `EXPRESS` {@link StateMachine} inside a function
 * runtime to run the workflow synchronously — the call returns once the
 * execution finishes, with its status and output. Not available for
 * `STANDARD` workflows.
 * @binding
 * @section Synchronous Execution
 * @example Run an EXPRESS workflow and read its output
 * ```typescript
 * const startSyncExecution = yield* StepFunctions.StartSyncExecution(machine);
 *
 * const result = yield* startSyncExecution({
 *   input: JSON.stringify({ value: 21 }),
 * });
 * if (result.status === "SUCCEEDED") {
 *   const output = JSON.parse(String(result.output));
 * }
 * ```
 */
export interface StartSyncExecution extends Binding.Service<
  StartSyncExecution,
  "AWS.StepFunctions.StartSyncExecution",
  (
    stateMachine: StateMachine,
  ) => Effect.Effect<
    (
      request?: StartSyncExecutionRequest,
    ) => Effect.Effect<
      sfn.StartSyncExecutionOutput,
      sfn.StartSyncExecutionError
    >
  >
> {}
export const StartSyncExecution = Binding.Service<StartSyncExecution>(
  "AWS.StepFunctions.StartSyncExecution",
);
