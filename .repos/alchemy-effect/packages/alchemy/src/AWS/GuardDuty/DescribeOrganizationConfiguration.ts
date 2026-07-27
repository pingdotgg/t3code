import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:DescribeOrganizationConfiguration`.
 *
 * Reads the organization's GuardDuty auto-enable configuration (delegated administrator only).
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.DescribeOrganizationConfigurationHttp)`.
 * @binding
 * @section Organization Administration
 * @example Read Org Configuration
 * ```typescript
 * // init
 * const describeOrganizationConfiguration = yield* AWS.GuardDuty.DescribeOrganizationConfiguration(detector);
 *
 * // runtime
 * const { AutoEnableOrganizationMembers } =
 *   yield* describeOrganizationConfiguration();
 * ```
 */
export interface DescribeOrganizationConfiguration extends Binding.Service<
  DescribeOrganizationConfiguration,
  "AWS.GuardDuty.DescribeOrganizationConfiguration",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<
        guardduty.DescribeOrganizationConfigurationRequest,
        "DetectorId"
      >,
    ) => Effect.Effect<
      guardduty.DescribeOrganizationConfigurationResponse,
      guardduty.DescribeOrganizationConfigurationError
    >
  >
> {}
export const DescribeOrganizationConfiguration =
  Binding.Service<DescribeOrganizationConfiguration>(
    "AWS.GuardDuty.DescribeOrganizationConfiguration",
  );
