import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:ListFindings`.
 *
 * Lists finding ids for the detector, with optional finding criteria and sort order — the entry point for a findings-triage automation.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.ListFindingsHttp)`.
 * @binding
 * @section Working with Findings
 * @example List Current Finding Ids
 * ```typescript
 * // init
 * const listFindings = yield* AWS.GuardDuty.ListFindings(detector);
 *
 * // runtime
 * const { FindingIds } = yield* listFindings();
 * ```
 */
export interface ListFindings extends Binding.Service<
  ListFindings,
  "AWS.GuardDuty.ListFindings",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.ListFindingsRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.ListFindingsResponse,
      guardduty.ListFindingsError
    >
  >
> {}
export const ListFindings = Binding.Service<ListFindings>(
  "AWS.GuardDuty.ListFindings",
);
