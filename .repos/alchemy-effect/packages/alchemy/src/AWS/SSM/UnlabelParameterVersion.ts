import type * as SSM from "@distilled.cloud/aws/ssm";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Parameter } from "./Parameter.ts";

export interface UnlabelParameterVersionRequest extends Omit<
  SSM.UnlabelParameterVersionRequest,
  "Name"
> {}

/**
 * Runtime binding for `ssm:UnlabelParameterVersion`.
 *
 * Bind this operation to a `Parameter` inside a function runtime to get a
 * callable that removes labels from a specific version of the bound
 * parameter — the counterpart to `LabelParameterVersion` when moving a label
 * during a rollout or rollback.
 * @binding
 * @section Labeling Parameter Versions
 * @example Remove a Label From a Version
 * ```typescript
 * const unlabel = yield* SSM.UnlabelParameterVersion(config);
 *
 * const result = yield* unlabel({
 *   ParameterVersion: 3,
 *   Labels: ["current"],
 * });
 * yield* Effect.log(`removed: ${result.RemovedLabels?.join(", ")}`);
 * ```
 */
export interface UnlabelParameterVersion extends Binding.Service<
  UnlabelParameterVersion,
  "AWS.SSM.UnlabelParameterVersion",
  <P extends Parameter>(
    parameter: P,
  ) => Effect.Effect<
    (
      request: UnlabelParameterVersionRequest,
    ) => Effect.Effect<
      SSM.UnlabelParameterVersionResult,
      SSM.UnlabelParameterVersionError
    >
  >
> {}
export const UnlabelParameterVersion = Binding.Service<UnlabelParameterVersion>(
  "AWS.SSM.UnlabelParameterVersion",
);
