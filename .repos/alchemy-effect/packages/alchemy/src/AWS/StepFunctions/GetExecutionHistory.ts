import type * as sfn from "@distilled.cloud/aws/sfn";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { StateMachine } from "./StateMachine.ts";

export interface GetExecutionHistoryRequest
  extends sfn.GetExecutionHistoryInput {}

/**
 * Runtime binding for `states:GetExecutionHistory`.
 *
 * Bind this operation to a {@link StateMachine} inside a function runtime
 * to page through an execution's event history (state transitions, task
 * results, failures). IAM access is scoped to executions of the bound
 * state machine. Not supported by `EXPRESS` state machines.
 * @binding
 * @section Polling Executions
 * @example Inspect why an execution failed
 * ```typescript
 * const getExecutionHistory =
 *   yield* StepFunctions.GetExecutionHistory(machine);
 *
 * const { events } = yield* getExecutionHistory({
 *   executionArn,
 *   reverseOrder: true,
 *   maxResults: 10,
 * });
 * // events[0].type === "ExecutionFailed" carries the error details
 * ```
 */
export interface GetExecutionHistory extends Binding.Service<
  GetExecutionHistory,
  "AWS.StepFunctions.GetExecutionHistory",
  (
    stateMachine: StateMachine,
  ) => Effect.Effect<
    (
      request: GetExecutionHistoryRequest,
    ) => Effect.Effect<
      sfn.GetExecutionHistoryOutput,
      sfn.GetExecutionHistoryError
    >
  >
> {}
export const GetExecutionHistory = Binding.Service<GetExecutionHistory>(
  "AWS.StepFunctions.GetExecutionHistory",
);
