import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:StartMonitoringMembers`.
 *
 * Resumes GuardDuty monitoring for member accounts previously stopped with `StopMonitoringMembers`.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.StartMonitoringMembersHttp)`.
 * @binding
 * @section Member Administration
 * @example Resume Monitoring
 * ```typescript
 * // init
 * const startMonitoringMembers = yield* AWS.GuardDuty.StartMonitoringMembers(detector);
 *
 * // runtime
 * yield* startMonitoringMembers({ AccountIds: ["111122223333"] });
 * ```
 */
export interface StartMonitoringMembers extends Binding.Service<
  StartMonitoringMembers,
  "AWS.GuardDuty.StartMonitoringMembers",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.StartMonitoringMembersRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.StartMonitoringMembersResponse,
      guardduty.StartMonitoringMembersError
    >
  >
> {}
export const StartMonitoringMembers = Binding.Service<StartMonitoringMembers>(
  "AWS.GuardDuty.StartMonitoringMembers",
);
