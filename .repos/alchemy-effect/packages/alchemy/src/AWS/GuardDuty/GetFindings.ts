import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:GetFindings`.
 *
 * Hydrates full finding details for a batch of finding ids returned by `ListFindings`.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.GetFindingsHttp)`.
 * @binding
 * @section Working with Findings
 * @example Hydrate Finding Details
 * ```typescript
 * // init
 * const getFindings = yield* AWS.GuardDuty.GetFindings(detector);
 *
 * // runtime
 * const { Findings } = yield* getFindings({ FindingIds: findingIds });
 * ```
 */
export interface GetFindings extends Binding.Service<
  GetFindings,
  "AWS.GuardDuty.GetFindings",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.GetFindingsRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.GetFindingsResponse,
      guardduty.GetFindingsError
    >
  >
> {}
export const GetFindings = Binding.Service<GetFindings>(
  "AWS.GuardDuty.GetFindings",
);
