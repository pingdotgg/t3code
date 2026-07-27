import type * as controltower from "@distilled.cloud/aws/controltower";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EnabledBaseline } from "./EnabledBaseline.ts";

/**
 * Runtime binding for `controltower:GetEnabledBaseline`.
 *
 * Bind this operation to an {@link EnabledBaseline} to read the
 * enablement's live status, drift status, and parameters from inside a
 * function runtime. Provide the implementation with
 * `Effect.provide(AWS.ControlTower.GetEnabledBaselineHttp)`.
 * @binding
 * @section Inspecting an Enabled Baseline
 * @example Read the Enabled Baseline's Status
 * ```typescript
 * // init — bind the operation to the enabled baseline
 * const getEnabledBaseline = yield* AWS.ControlTower.GetEnabledBaseline(ouBaseline);
 *
 * // runtime
 * const { enabledBaselineDetails } = yield* getEnabledBaseline();
 * console.log(enabledBaselineDetails?.statusSummary.status);
 * ```
 */
export interface GetEnabledBaseline extends Binding.Service<
  GetEnabledBaseline,
  "AWS.ControlTower.GetEnabledBaseline",
  (
    enabledBaseline: EnabledBaseline,
  ) => Effect.Effect<
    () => Effect.Effect<
      controltower.GetEnabledBaselineOutput,
      controltower.GetEnabledBaselineError
    >
  >
> {}

export const GetEnabledBaseline = Binding.Service<GetEnabledBaseline>(
  "AWS.ControlTower.GetEnabledBaseline",
);
