import type * as sfn from "@distilled.cloud/aws/sfn";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { StateMachine } from "./StateMachine.ts";

export interface DescribeExecutionRequest extends sfn.DescribeExecutionInput {}

/**
 * Runtime binding for `states:DescribeExecution`.
 *
 * Bind this operation to a {@link StateMachine} inside a function runtime to
 * poll the status and output of that machine's executions. IAM access is
 * scoped to executions of the bound state machine.
 * @binding
 * @section Polling Executions
 * @example Check an execution's status
 * ```typescript
 * const describeExecution = yield* StepFunctions.DescribeExecution(machine);
 *
 * const execution = yield* describeExecution({ executionArn });
 * // execution.status: "RUNNING" | "SUCCEEDED" | "FAILED" | ...
 * ```
 */
export interface DescribeExecution extends Binding.Service<
  DescribeExecution,
  "AWS.StepFunctions.DescribeExecution",
  (
    stateMachine: StateMachine,
  ) => Effect.Effect<
    (
      request: DescribeExecutionRequest,
    ) => Effect.Effect<sfn.DescribeExecutionOutput, sfn.DescribeExecutionError>
  >
> {}
export const DescribeExecution = Binding.Service<DescribeExecution>(
  "AWS.StepFunctions.DescribeExecution",
);
