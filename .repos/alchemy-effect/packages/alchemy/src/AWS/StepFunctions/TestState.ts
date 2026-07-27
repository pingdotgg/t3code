import type * as sfn from "@distilled.cloud/aws/sfn";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface TestStateRequest extends sfn.TestStateInput {}

/**
 * Runtime binding for `states:TestState` — execute a *single* ASL state
 * (Task, Pass, Wait, Choice, Succeed, Fail) without creating a state
 * machine, optionally with mocked service integrations.
 *
 * Service-scoped (no resource argument). States that call other services
 * (e.g. `lambda:invoke`) need a `roleArn` the caller can `iam:PassRole` —
 * intrinsic states (Pass/Choice/Succeed/Fail) run without one.
 * @binding
 * @section Testing States
 * @example Test a Pass state's output processing
 * ```typescript
 * const testState = yield* StepFunctions.TestState();
 *
 * const result = yield* testState({
 *   definition: JSON.stringify({
 *     Type: "Pass",
 *     QueryLanguage: "JSONata",
 *     Output: "{% $states.input.value * 2 %}",
 *     End: true,
 *   }),
 *   input: JSON.stringify({ value: 21 }),
 * });
 * // result.status === "SUCCEEDED", result.output === "42"
 * ```
 */
export interface TestState extends Binding.Service<
  TestState,
  "AWS.StepFunctions.TestState",
  () => Effect.Effect<
    (
      request: TestStateRequest,
    ) => Effect.Effect<sfn.TestStateOutput, sfn.TestStateError>
  >
> {}
export const TestState = Binding.Service<TestState>(
  "AWS.StepFunctions.TestState",
);
