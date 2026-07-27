import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:UpdateMemberDetectors`.
 *
 * Updates the feature configuration of member detectors from the administrator account.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.UpdateMemberDetectorsHttp)`.
 * @binding
 * @section Member Administration
 * @example Enable a Feature for Members
 * ```typescript
 * // init
 * const updateMemberDetectors = yield* AWS.GuardDuty.UpdateMemberDetectors(detector);
 *
 * // runtime
 * yield* updateMemberDetectors({
 *   AccountIds: ["111122223333"],
 *   Features: [{ Name: "S3_DATA_EVENTS", Status: "ENABLED" }],
 * });
 * ```
 */
export interface UpdateMemberDetectors extends Binding.Service<
  UpdateMemberDetectors,
  "AWS.GuardDuty.UpdateMemberDetectors",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.UpdateMemberDetectorsRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.UpdateMemberDetectorsResponse,
      guardduty.UpdateMemberDetectorsError
    >
  >
> {}
export const UpdateMemberDetectors = Binding.Service<UpdateMemberDetectors>(
  "AWS.GuardDuty.UpdateMemberDetectors",
);
