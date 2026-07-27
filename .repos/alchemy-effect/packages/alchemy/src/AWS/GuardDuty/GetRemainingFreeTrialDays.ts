import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:GetRemainingFreeTrialDays`.
 *
 * Reports the remaining free-trial days per data source for the given member account ids.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.GetRemainingFreeTrialDaysHttp)`.
 * @binding
 * @section Usage & Coverage
 * @example Check Free-Trial Days
 * ```typescript
 * // init
 * const getRemainingFreeTrialDays = yield* AWS.GuardDuty.GetRemainingFreeTrialDays(detector);
 *
 * // runtime
 * const { Accounts } = yield* getRemainingFreeTrialDays({
 *   AccountIds: ["111122223333"],
 * });
 * ```
 */
export interface GetRemainingFreeTrialDays extends Binding.Service<
  GetRemainingFreeTrialDays,
  "AWS.GuardDuty.GetRemainingFreeTrialDays",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request: Omit<guardduty.GetRemainingFreeTrialDaysRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.GetRemainingFreeTrialDaysResponse,
      guardduty.GetRemainingFreeTrialDaysError
    >
  >
> {}
export const GetRemainingFreeTrialDays =
  Binding.Service<GetRemainingFreeTrialDays>(
    "AWS.GuardDuty.GetRemainingFreeTrialDays",
  );
