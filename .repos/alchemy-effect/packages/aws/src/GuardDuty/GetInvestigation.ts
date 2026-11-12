import type * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:GetInvestigation`.
 *
 * Reads an investigation's status, risk details, and results by investigation id.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.GetInvestigationHttp)`.
 * ### Extended Threat Detection
 * **Example:** Read an Investigation
 * ```typescript
 * // init
 * const getInvestigation = yield* AWS.GuardDuty.GetInvestigation(detector);
 *
 * // runtime
 * const { Investigation } = yield* getInvestigation({
 *   InvestigationId: investigationId,
 * });
 * ```
 *
 * @binding
 */
export interface GetInvestigation extends Binding.Service<
  GetInvestigation,
  "AWS.GuardDuty.GetInvestigation",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request: Omit<guardduty.GetInvestigationRequest, "DetectorId">,
    ) => Effect.Effect<guardduty.GetInvestigationResponse, guardduty.GetInvestigationError>
  >
> {}
export const GetInvestigation = Binding.Service<GetInvestigation>("AWS.GuardDuty.GetInvestigation");
