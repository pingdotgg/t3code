import type * as sfn from "@distilled.cloud/aws/sfn";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { StateMachine } from "./StateMachine.ts";

export interface ListExecutionsRequest extends Omit<
  sfn.ListExecutionsInput,
  "stateMachineArn"
> {}

/**
 * Runtime binding for `states:ListExecutions`.
 *
 * Bind this operation to a {@link StateMachine} inside a function runtime
 * to list that machine's executions (optionally filtered by status) with
 * the state machine ARN injected automatically. Not supported by `EXPRESS`
 * state machines.
 * @binding
 * @section Polling Executions
 * @example List running executions
 * ```typescript
 * const listExecutions = yield* StepFunctions.ListExecutions(machine);
 *
 * const { executions } = yield* listExecutions({ statusFilter: "RUNNING" });
 * ```
 */
export interface ListExecutions extends Binding.Service<
  ListExecutions,
  "AWS.StepFunctions.ListExecutions",
  (
    stateMachine: StateMachine,
  ) => Effect.Effect<
    (
      request?: ListExecutionsRequest,
    ) => Effect.Effect<sfn.ListExecutionsOutput, sfn.ListExecutionsError>
  >
> {}
export const ListExecutions = Binding.Service<ListExecutions>(
  "AWS.StepFunctions.ListExecutions",
);
