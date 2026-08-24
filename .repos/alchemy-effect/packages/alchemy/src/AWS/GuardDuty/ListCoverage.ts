import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:ListCoverage`.
 *
 * Enumerates per-resource coverage details — which EKS clusters, EC2 instances, and ECS clusters report runtime telemetry and why any are unhealthy.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.ListCoverageHttp)`.
 * @binding
 * @section Usage & Coverage
 * @example List Coverage Details
 * ```typescript
 * // init
 * const listCoverage = yield* AWS.GuardDuty.ListCoverage(detector);
 *
 * // runtime
 * const { Resources } = yield* listCoverage();
 * ```
 */
export interface ListCoverage extends Binding.Service<
  ListCoverage,
  "AWS.GuardDuty.ListCoverage",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.ListCoverageRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.ListCoverageResponse,
      guardduty.ListCoverageError
    >
  >
> {}
export const ListCoverage = Binding.Service<ListCoverage>(
  "AWS.GuardDuty.ListCoverage",
);
