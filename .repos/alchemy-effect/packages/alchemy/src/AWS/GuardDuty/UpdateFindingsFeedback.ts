import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:UpdateFindingsFeedback`.
 *
 * Marks findings as `USEFUL` or `NOT_USEFUL` to tune GuardDuty's signal quality.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.UpdateFindingsFeedbackHttp)`.
 * @binding
 * @section Working with Findings
 * @example Mark Findings Useful
 * ```typescript
 * // init
 * const updateFindingsFeedback = yield* AWS.GuardDuty.UpdateFindingsFeedback(detector);
 *
 * // runtime
 * yield* updateFindingsFeedback({
 *   FindingIds: findingIds,
 *   Feedback: "USEFUL",
 * });
 * ```
 */
export interface UpdateFindingsFeedback extends Binding.Service<
  UpdateFindingsFeedback,
  "AWS.GuardDuty.UpdateFindingsFeedback",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.UpdateFindingsFeedbackRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.UpdateFindingsFeedbackResponse,
      guardduty.UpdateFindingsFeedbackError
    >
  >
> {}
export const UpdateFindingsFeedback = Binding.Service<UpdateFindingsFeedback>(
  "AWS.GuardDuty.UpdateFindingsFeedback",
);
