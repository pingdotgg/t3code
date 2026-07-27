import type * as controltower from "@distilled.cloud/aws/controltower";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EnabledControl } from "./EnabledControl.ts";

/**
 * Runtime binding for `controltower:GetEnabledControl`.
 *
 * Bind this operation to an {@link EnabledControl} to read the enablement's
 * live status, drift status, and parameters from inside a function runtime.
 * Useful for drift-monitoring functions that alert when a guardrail drifts.
 * Provide the implementation with
 * `Effect.provide(AWS.ControlTower.GetEnabledControlHttp)`.
 * @binding
 * @section Inspecting an Enabled Control
 * @example Read the Enabled Control's Drift Status
 * ```typescript
 * // init — bind the operation to the enabled control
 * const getEnabledControl = yield* AWS.ControlTower.GetEnabledControl(guardrail);
 *
 * // runtime
 * const { enabledControlDetails } = yield* getEnabledControl();
 * console.log(enabledControlDetails.driftStatusSummary?.driftStatus);
 * ```
 */
export interface GetEnabledControl extends Binding.Service<
  GetEnabledControl,
  "AWS.ControlTower.GetEnabledControl",
  (
    enabledControl: EnabledControl,
  ) => Effect.Effect<
    () => Effect.Effect<
      controltower.GetEnabledControlOutput,
      controltower.GetEnabledControlError
    >
  >
> {}

export const GetEnabledControl = Binding.Service<GetEnabledControl>(
  "AWS.ControlTower.GetEnabledControl",
);
