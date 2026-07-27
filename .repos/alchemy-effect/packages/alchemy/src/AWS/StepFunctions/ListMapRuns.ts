import type * as sfn from "@distilled.cloud/aws/sfn";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { StateMachine } from "./StateMachine.ts";

export interface ListMapRunsRequest extends sfn.ListMapRunsInput {}

/**
 * Runtime binding for `states:ListMapRuns`.
 *
 * Lists the Distributed Map Runs started by an execution of the bound
 * {@link StateMachine} — use the returned `mapRunArn`s with
 * `DescribeMapRun` / `UpdateMapRun`. IAM access is scoped to executions of
 * the bound state machine.
 * @binding
 * @section Distributed Map Runs
 * @example List an execution's Map Runs
 * ```typescript
 * const listMapRuns = yield* StepFunctions.ListMapRuns(machine);
 *
 * const { mapRuns } = yield* listMapRuns({ executionArn });
 * ```
 */
export interface ListMapRuns extends Binding.Service<
  ListMapRuns,
  "AWS.StepFunctions.ListMapRuns",
  (
    stateMachine: StateMachine,
  ) => Effect.Effect<
    (
      request: ListMapRunsRequest,
    ) => Effect.Effect<sfn.ListMapRunsOutput, sfn.ListMapRunsError>
  >
> {}
export const ListMapRuns = Binding.Service<ListMapRuns>(
  "AWS.StepFunctions.ListMapRuns",
);
