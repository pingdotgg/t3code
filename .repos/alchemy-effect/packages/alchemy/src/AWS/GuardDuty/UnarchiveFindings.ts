import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:UnarchiveFindings`.
 *
 * Restores archived findings back into the detector's active queue.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.UnarchiveFindingsHttp)`.
 * @binding
 * @section Working with Findings
 * @example Unarchive Findings
 * ```typescript
 * // init
 * const unarchiveFindings = yield* AWS.GuardDuty.UnarchiveFindings(detector);
 *
 * // runtime
 * yield* unarchiveFindings({ FindingIds: findingIds });
 * ```
 */
export interface UnarchiveFindings extends Binding.Service<
  UnarchiveFindings,
  "AWS.GuardDuty.UnarchiveFindings",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.UnarchiveFindingsRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.UnarchiveFindingsResponse,
      guardduty.UnarchiveFindingsError
    >
  >
> {}
export const UnarchiveFindings = Binding.Service<UnarchiveFindings>(
  "AWS.GuardDuty.UnarchiveFindings",
);
