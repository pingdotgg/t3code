import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:StopMonitoringMembers`.
 *
 * Pauses GuardDuty monitoring for the given member accounts.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.StopMonitoringMembersHttp)`.
 * @binding
 * @section Member Administration
 * @example Pause Monitoring
 * ```typescript
 * // init
 * const stopMonitoringMembers = yield* AWS.GuardDuty.StopMonitoringMembers(detector);
 *
 * // runtime
 * yield* stopMonitoringMembers({ AccountIds: ["111122223333"] });
 * ```
 */
export interface StopMonitoringMembers extends Binding.Service<
  StopMonitoringMembers,
  "AWS.GuardDuty.StopMonitoringMembers",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.StopMonitoringMembersRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.StopMonitoringMembersResponse,
      guardduty.StopMonitoringMembersError
    >
  >
> {}
export const StopMonitoringMembers = Binding.Service<StopMonitoringMembers>(
  "AWS.GuardDuty.StopMonitoringMembers",
);
