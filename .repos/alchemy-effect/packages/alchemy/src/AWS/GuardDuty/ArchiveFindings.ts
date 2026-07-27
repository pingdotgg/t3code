import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:ArchiveFindings`.
 *
 * Archives triaged findings so they stop surfacing in the active queue. Only the administrator account owning the detector can archive.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.ArchiveFindingsHttp)`.
 * @binding
 * @section Working with Findings
 * @example Archive Triaged Findings
 * ```typescript
 * // init
 * const archiveFindings = yield* AWS.GuardDuty.ArchiveFindings(detector);
 *
 * // runtime
 * yield* archiveFindings({ FindingIds: findingIds });
 * ```
 */
export interface ArchiveFindings extends Binding.Service<
  ArchiveFindings,
  "AWS.GuardDuty.ArchiveFindings",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.ArchiveFindingsRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.ArchiveFindingsResponse,
      guardduty.ArchiveFindingsError
    >
  >
> {}
export const ArchiveFindings = Binding.Service<ArchiveFindings>(
  "AWS.GuardDuty.ArchiveFindings",
);
