import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:CreateInvestigation`.
 *
 * Starts a GuardDuty Extended Threat Detection investigation from a natural-language trigger prompt.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.CreateInvestigationHttp)`.
 * @binding
 * @section Extended Threat Detection
 * @example Start an Investigation
 * ```typescript
 * // init
 * const createInvestigation = yield* AWS.GuardDuty.CreateInvestigation(detector);
 *
 * // runtime
 * const { InvestigationId } = yield* createInvestigation({
 *   TriggerPrompt: "Investigate the port probe findings on my web tier",
 * });
 * ```
 */
export interface CreateInvestigation extends Binding.Service<
  CreateInvestigation,
  "AWS.GuardDuty.CreateInvestigation",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.CreateInvestigationRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.CreateInvestigationResponse,
      guardduty.CreateInvestigationError
    >
  >
> {}
export const CreateInvestigation = Binding.Service<CreateInvestigation>(
  "AWS.GuardDuty.CreateInvestigation",
);
