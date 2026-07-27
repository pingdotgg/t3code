import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:GetMemberDetectors`.
 *
 * Reads the data-source and feature configuration of member detectors.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.GetMemberDetectorsHttp)`.
 * @binding
 * @section Member Administration
 * @example Read Member Detector Config
 * ```typescript
 * // init
 * const getMemberDetectors = yield* AWS.GuardDuty.GetMemberDetectors(detector);
 *
 * // runtime
 * const { MemberDataSourceConfigurations } = yield* getMemberDetectors({
 *   AccountIds: ["111122223333"],
 * });
 * ```
 */
export interface GetMemberDetectors extends Binding.Service<
  GetMemberDetectors,
  "AWS.GuardDuty.GetMemberDetectors",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.GetMemberDetectorsRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.GetMemberDetectorsResponse,
      guardduty.GetMemberDetectorsError
    >
  >
> {}
export const GetMemberDetectors = Binding.Service<GetMemberDetectors>(
  "AWS.GuardDuty.GetMemberDetectors",
);
