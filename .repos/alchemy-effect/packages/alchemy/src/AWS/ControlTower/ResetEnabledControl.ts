import type * as controltower from "@distilled.cloud/aws/controltower";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EnabledControl } from "./EnabledControl.ts";

/**
 * Runtime binding for `controltower:ResetEnabledControl`.
 *
 * Bind this operation to an {@link EnabledControl} to re-deploy the
 * guardrail's governance resources from inside a function runtime —
 * remediating drift without changing the enablement's configuration. The
 * call starts an asynchronous operation; poll it with
 * {@link GetControlOperation}. Provide the implementation with
 * `Effect.provide(AWS.ControlTower.ResetEnabledControlHttp)`.
 * @binding
 * @section Remediating Drift
 * @example Reset a Drifted Enabled Control
 * ```typescript
 * // init — bind the operation to the enabled control
 * const resetEnabledControl = yield* AWS.ControlTower.ResetEnabledControl(guardrail);
 *
 * // runtime
 * const { operationIdentifier } = yield* resetEnabledControl();
 * ```
 */
export interface ResetEnabledControl extends Binding.Service<
  ResetEnabledControl,
  "AWS.ControlTower.ResetEnabledControl",
  (
    enabledControl: EnabledControl,
  ) => Effect.Effect<
    () => Effect.Effect<
      controltower.ResetEnabledControlOutput,
      controltower.ResetEnabledControlError
    >
  >
> {}

export const ResetEnabledControl = Binding.Service<ResetEnabledControl>(
  "AWS.ControlTower.ResetEnabledControl",
);
