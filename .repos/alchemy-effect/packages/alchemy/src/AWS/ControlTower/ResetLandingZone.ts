import type * as controltower from "@distilled.cloud/aws/controltower";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LandingZone } from "./LandingZone.ts";

/**
 * Runtime binding for `controltower:ResetLandingZone`.
 *
 * Bind this operation to a {@link LandingZone} to re-deploy the landing
 * zone to its last-known configuration from inside a function runtime —
 * remediating landing zone drift. The call starts an asynchronous operation
 * (landing zone operations routinely take an hour); poll it with
 * {@link GetLandingZoneOperation}. Provide the implementation with
 * `Effect.provide(AWS.ControlTower.ResetLandingZoneHttp)`.
 * @binding
 * @section Remediating Drift
 * @example Reset a Drifted Landing Zone
 * ```typescript
 * // init — bind the operation to the landing zone
 * const resetLandingZone = yield* AWS.ControlTower.ResetLandingZone(landingZone);
 *
 * // runtime
 * const { operationIdentifier } = yield* resetLandingZone();
 * ```
 */
export interface ResetLandingZone extends Binding.Service<
  ResetLandingZone,
  "AWS.ControlTower.ResetLandingZone",
  (
    landingZone: LandingZone,
  ) => Effect.Effect<
    () => Effect.Effect<
      controltower.ResetLandingZoneOutput,
      controltower.ResetLandingZoneError
    >
  >
> {}

export const ResetLandingZone = Binding.Service<ResetLandingZone>(
  "AWS.ControlTower.ResetLandingZone",
);
