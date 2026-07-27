import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:ListInvestigations`.
 *
 * Lists the detector's investigations with optional sort criteria.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.ListInvestigationsHttp)`.
 * @binding
 * @section Extended Threat Detection
 * @example List Investigations
 * ```typescript
 * // init
 * const listInvestigations = yield* AWS.GuardDuty.ListInvestigations(detector);
 *
 * // runtime
 * const { Investigations } = yield* listInvestigations();
 * ```
 */
export interface ListInvestigations extends Binding.Service<
  ListInvestigations,
  "AWS.GuardDuty.ListInvestigations",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.ListInvestigationsRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.ListInvestigationsResponse,
      guardduty.ListInvestigationsError
    >
  >
> {}
export const ListInvestigations = Binding.Service<ListInvestigations>(
  "AWS.GuardDuty.ListInvestigations",
);
