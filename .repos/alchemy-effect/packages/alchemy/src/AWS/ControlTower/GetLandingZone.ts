import type * as controltower from "@distilled.cloud/aws/controltower";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `controltower:GetLandingZone`.
 *
 * An account-level operation that reads the landing zone's version, status,
 * drift status, and manifest by its ARN (discovered via
 * {@link ListLandingZones}). Useful for drift-monitoring functions that
 * alert when the landing zone drifts out of sync. Provide the
 * implementation with `Effect.provide(AWS.ControlTower.GetLandingZoneHttp)`.
 * @binding
 * @section Inspecting the Landing Zone
 * @example Read the Landing Zone's Drift Status
 * ```typescript
 * // init — account-level binding takes no resource
 * const getLandingZone = yield* AWS.ControlTower.GetLandingZone();
 *
 * // runtime
 * const { landingZone } = yield* getLandingZone({
 *   landingZoneIdentifier: arn,
 * });
 * console.log(landingZone.driftStatus?.status);
 * ```
 */
export interface GetLandingZone extends Binding.Service<
  GetLandingZone,
  "AWS.ControlTower.GetLandingZone",
  () => Effect.Effect<
    (
      request: controltower.GetLandingZoneInput,
    ) => Effect.Effect<
      controltower.GetLandingZoneOutput,
      controltower.GetLandingZoneError
    >
  >
> {}

export const GetLandingZone = Binding.Service<GetLandingZone>(
  "AWS.ControlTower.GetLandingZone",
);
