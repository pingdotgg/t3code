import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:CreateSampleFindings`.
 *
 * Generates sample findings of the requested types — the standard way to exercise a finding-consumer pipeline end-to-end without staging a real threat.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.CreateSampleFindingsHttp)`.
 * @binding
 * @section Working with Findings
 * @example Generate a Sample Finding
 * ```typescript
 * // init
 * const createSampleFindings = yield* AWS.GuardDuty.CreateSampleFindings(detector);
 *
 * // runtime
 * yield* createSampleFindings({
 *   FindingTypes: ["Recon:EC2/PortProbeUnprotectedPort"],
 * });
 * ```
 */
export interface CreateSampleFindings extends Binding.Service<
  CreateSampleFindings,
  "AWS.GuardDuty.CreateSampleFindings",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.CreateSampleFindingsRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.CreateSampleFindingsResponse,
      guardduty.CreateSampleFindingsError
    >
  >
> {}
export const CreateSampleFindings = Binding.Service<CreateSampleFindings>(
  "AWS.GuardDuty.CreateSampleFindings",
);
