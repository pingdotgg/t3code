import type * as controltower from "@distilled.cloud/aws/controltower";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `controltower:ListLandingZones`.
 *
 * An account-level operation that returns the organization's landing zone
 * ARN (a landing zone is a singleton — the list has at most one entry).
 * Useful for governance functions that discover the landing zone before
 * reading its drift status. Provide the implementation with
 * `Effect.provide(AWS.ControlTower.ListLandingZonesHttp)`.
 * @binding
 * @section Inspecting the Landing Zone
 * @example Discover the Landing Zone ARN
 * ```typescript
 * // init — account-level binding takes no resource
 * const listLandingZones = yield* AWS.ControlTower.ListLandingZones();
 *
 * // runtime
 * const result = yield* listLandingZones();
 * const arn = result.landingZones[0]?.arn;
 * ```
 */
export interface ListLandingZones extends Binding.Service<
  ListLandingZones,
  "AWS.ControlTower.ListLandingZones",
  () => Effect.Effect<
    (
      request?: controltower.ListLandingZonesInput,
    ) => Effect.Effect<
      controltower.ListLandingZonesOutput,
      controltower.ListLandingZonesError
    >
  >
> {}

export const ListLandingZones = Binding.Service<ListLandingZones>(
  "AWS.ControlTower.ListLandingZones",
);
