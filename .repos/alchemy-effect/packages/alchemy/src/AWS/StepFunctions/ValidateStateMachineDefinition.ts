import type * as sfn from "@distilled.cloud/aws/sfn";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ValidateStateMachineDefinitionRequest
  extends sfn.ValidateStateMachineDefinitionInput {}

/**
 * Runtime binding for `states:ValidateStateMachineDefinition` — AWS's
 * static ASL validator (the Tier-4 check op for the Step Functions DSL).
 *
 * Service-scoped (no resource argument): validates any definition string
 * without creating or updating a state machine. `StateMachine`'s reconcile
 * runs this same check as a pre-flight; bind it in a function runtime to
 * validate definitions on demand (e.g. compiled `Sfn` programs before a
 * deployment pipeline applies them).
 * @binding
 * @section Validating Definitions
 * @example Validate a definition string
 * ```typescript
 * const validate = yield* StepFunctions.ValidateStateMachineDefinition();
 *
 * const report = yield* validate({
 *   definition: JSON.stringify(definition),
 *   type: "EXPRESS",
 *   severity: "ERROR",
 * });
 * // report.result === "OK" | "FAIL"; report.diagnostics lists findings
 * ```
 */
export interface ValidateStateMachineDefinition extends Binding.Service<
  ValidateStateMachineDefinition,
  "AWS.StepFunctions.ValidateStateMachineDefinition",
  () => Effect.Effect<
    (
      request: ValidateStateMachineDefinitionRequest,
    ) => Effect.Effect<
      sfn.ValidateStateMachineDefinitionOutput,
      sfn.ValidateStateMachineDefinitionError
    >
  >
> {}
export const ValidateStateMachineDefinition =
  Binding.Service<ValidateStateMachineDefinition>(
    "AWS.StepFunctions.ValidateStateMachineDefinition",
  );
