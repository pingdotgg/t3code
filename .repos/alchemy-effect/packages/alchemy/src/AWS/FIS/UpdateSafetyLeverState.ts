import type * as fis from "@distilled.cloud/aws/fis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `fis:UpdateSafetyLeverState`.
 *
 * Engages or disengages the account's safety lever — engaging it stops all
 * running experiments and blocks new ones until it is disengaged, the
 * account-wide chaos kill switch an ops function flips when a stop condition
 * outside FIS's view fires. The account's lever has the well-known id
 * `default`. Provide the implementation with
 * `Effect.provide(AWS.FIS.UpdateSafetyLeverStateHttp)`.
 * @binding
 * @section The Safety Lever
 * @example Halt All Experiments
 * ```typescript
 * // init — account-level binding, no resource argument
 * const updateSafetyLeverState = yield* AWS.FIS.UpdateSafetyLeverState();
 *
 * // runtime
 * yield* updateSafetyLeverState({
 *   id: "default",
 *   state: { status: "engaged", reason: "elevated error budget burn" },
 * });
 * ```
 */
export interface UpdateSafetyLeverState extends Binding.Service<
  UpdateSafetyLeverState,
  "AWS.FIS.UpdateSafetyLeverState",
  () => Effect.Effect<
    (
      request: fis.UpdateSafetyLeverStateRequest,
    ) => Effect.Effect<
      fis.UpdateSafetyLeverStateResponse,
      fis.UpdateSafetyLeverStateError
    >
  >
> {}
export const UpdateSafetyLeverState = Binding.Service<UpdateSafetyLeverState>(
  "AWS.FIS.UpdateSafetyLeverState",
);
