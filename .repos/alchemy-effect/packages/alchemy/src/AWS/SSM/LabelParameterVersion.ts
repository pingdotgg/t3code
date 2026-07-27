import type * as SSM from "@distilled.cloud/aws/ssm";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Parameter } from "./Parameter.ts";

export interface LabelParameterVersionRequest extends Omit<
  SSM.LabelParameterVersionRequest,
  "Name"
> {}

/**
 * Runtime binding for `ssm:LabelParameterVersion`.
 *
 * Bind this operation to a `Parameter` inside a function runtime to get a
 * callable that attaches labels (e.g. `current`, `stable`) to a version of
 * the bound parameter. Omitting `ParameterVersion` labels the latest version.
 * Labels enable versioned rollouts: readers pass `Name:label` selectors to
 * `GetParameter` while writers move the label between versions.
 * @binding
 * @section Labeling Parameter Versions
 * @example Mark the Latest Version as Current
 * ```typescript
 * const label = yield* SSM.LabelParameterVersion(config);
 *
 * const result = yield* label({ Labels: ["current"] });
 * yield* Effect.log(`labeled version ${result.ParameterVersion}`);
 * ```
 */
export interface LabelParameterVersion extends Binding.Service<
  LabelParameterVersion,
  "AWS.SSM.LabelParameterVersion",
  <P extends Parameter>(
    parameter: P,
  ) => Effect.Effect<
    (
      request: LabelParameterVersionRequest,
    ) => Effect.Effect<
      SSM.LabelParameterVersionResult,
      SSM.LabelParameterVersionError
    >
  >
> {}
export const LabelParameterVersion = Binding.Service<LabelParameterVersion>(
  "AWS.SSM.LabelParameterVersion",
);
