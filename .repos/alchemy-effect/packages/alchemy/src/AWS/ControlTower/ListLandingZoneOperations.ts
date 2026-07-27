import type * as controltower from "@distilled.cloud/aws/controltower";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `controltower:ListLandingZoneOperations`.
 *
 * An account-level operation that enumerates recent landing zone operations
 * (creates, updates, deletes, and resets), optionally filtered by type or
 * status. Useful for governance dashboards that surface in-flight landing
 * zone upgrades. Provide the implementation with
 * `Effect.provide(AWS.ControlTower.ListLandingZoneOperationsHttp)`.
 * @binding
 * @section Polling Asynchronous Operations
 * @example List In-Progress Landing Zone Operations
 * ```typescript
 * // init — account-level binding takes no resource
 * const listLandingZoneOperations =
 *   yield* AWS.ControlTower.ListLandingZoneOperations();
 *
 * // runtime
 * const result = yield* listLandingZoneOperations({
 *   filter: { statuses: ["IN_PROGRESS"] },
 * });
 * console.log(result.landingZoneOperations.length);
 * ```
 */
export interface ListLandingZoneOperations extends Binding.Service<
  ListLandingZoneOperations,
  "AWS.ControlTower.ListLandingZoneOperations",
  () => Effect.Effect<
    (
      request?: controltower.ListLandingZoneOperationsInput,
    ) => Effect.Effect<
      controltower.ListLandingZoneOperationsOutput,
      controltower.ListLandingZoneOperationsError
    >
  >
> {}

export const ListLandingZoneOperations =
  Binding.Service<ListLandingZoneOperations>(
    "AWS.ControlTower.ListLandingZoneOperations",
  );
