import type * as sfn from "@distilled.cloud/aws/sfn";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { StateMachine } from "./StateMachine.ts";

export interface RedriveExecutionRequest extends sfn.RedriveExecutionInput {}

/**
 * Runtime binding for `states:RedriveExecution`.
 *
 * Restarts a failed, aborted, or timed-out `STANDARD` execution from its
 * failure point, reusing the same input and execution ARN. IAM access is
 * scoped to executions of the bound {@link StateMachine}. Executions that
 * are still running (or succeeded) fail with the typed
 * `ExecutionNotRedrivable` error.
 * @binding
 * @section Redriving Executions
 * @example Redrive a failed execution
 * ```typescript
 * const redriveExecution = yield* StepFunctions.RedriveExecution(machine);
 *
 * yield* redriveExecution({ executionArn }).pipe(
 *   Effect.catchTag("ExecutionNotRedrivable", () => Effect.void),
 * );
 * ```
 */
export interface RedriveExecution extends Binding.Service<
  RedriveExecution,
  "AWS.StepFunctions.RedriveExecution",
  (
    stateMachine: StateMachine,
  ) => Effect.Effect<
    (
      request: RedriveExecutionRequest,
    ) => Effect.Effect<sfn.RedriveExecutionOutput, sfn.RedriveExecutionError>
  >
> {}
export const RedriveExecution = Binding.Service<RedriveExecution>(
  "AWS.StepFunctions.RedriveExecution",
);
