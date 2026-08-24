import type * as controltower from "@distilled.cloud/aws/controltower";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EnabledBaseline } from "./EnabledBaseline.ts";

/**
 * Runtime binding for `controltower:ResetEnabledBaseline`.
 *
 * Bind this operation to an {@link EnabledBaseline} to re-enroll the
 * target with its baseline from inside a function runtime — remediating
 * drift without changing the enablement's configuration. The call starts an
 * asynchronous operation; poll it with {@link GetBaselineOperation}.
 * Provide the implementation with
 * `Effect.provide(AWS.ControlTower.ResetEnabledBaselineHttp)`.
 * @binding
 * @section Remediating Drift
 * @example Reset a Drifted Enabled Baseline
 * ```typescript
 * // init — bind the operation to the enabled baseline
 * const resetEnabledBaseline = yield* AWS.ControlTower.ResetEnabledBaseline(ouBaseline);
 *
 * // runtime
 * const { operationIdentifier } = yield* resetEnabledBaseline();
 * ```
 */
export interface ResetEnabledBaseline extends Binding.Service<
  ResetEnabledBaseline,
  "AWS.ControlTower.ResetEnabledBaseline",
  (
    enabledBaseline: EnabledBaseline,
  ) => Effect.Effect<
    () => Effect.Effect<
      controltower.ResetEnabledBaselineOutput,
      controltower.ResetEnabledBaselineError
    >
  >
> {}

export const ResetEnabledBaseline = Binding.Service<ResetEnabledBaseline>(
  "AWS.ControlTower.ResetEnabledBaseline",
);
