import type * as sfn from "@distilled.cloud/aws/sfn";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { StateMachine } from "./StateMachine.ts";

export interface DescribeMapRunRequest extends sfn.DescribeMapRunInput {}

/**
 * Runtime binding for `states:DescribeMapRun`.
 *
 * Returns a Distributed Map Run's status, item counts, and configuration.
 * IAM access is scoped to Map Runs of the bound {@link StateMachine};
 * obtain `mapRunArn`s from `ListMapRuns`.
 * @binding
 * @section Distributed Map Runs
 * @example Inspect a Map Run's progress
 * ```typescript
 * const describeMapRun = yield* StepFunctions.DescribeMapRun(machine);
 *
 * const mapRun = yield* describeMapRun({ mapRunArn });
 * // mapRun.status, mapRun.itemCounts.succeeded, ...
 * ```
 */
export interface DescribeMapRun extends Binding.Service<
  DescribeMapRun,
  "AWS.StepFunctions.DescribeMapRun",
  (
    stateMachine: StateMachine,
  ) => Effect.Effect<
    (
      request: DescribeMapRunRequest,
    ) => Effect.Effect<sfn.DescribeMapRunOutput, sfn.DescribeMapRunError>
  >
> {}
export const DescribeMapRun = Binding.Service<DescribeMapRun>(
  "AWS.StepFunctions.DescribeMapRun",
);
