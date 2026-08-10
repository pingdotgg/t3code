import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:DescribeOrganizationConfiguration`.
 *
 * Returns how Security Hub is configured across the organization (auto-enable, central configuration).
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.DescribeOrganizationConfigurationHttp)`.
 * @binding
 * @section Members & Organization
 * @example Read the Organization Configuration
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeOrganizationConfiguration = yield* AWS.SecurityHub.DescribeOrganizationConfiguration();
 *
 * // runtime
 * const { AutoEnable } = yield* describeOrganizationConfiguration();
 * ```
 */
export interface DescribeOrganizationConfiguration extends Binding.Service<
  DescribeOrganizationConfiguration,
  "AWS.SecurityHub.DescribeOrganizationConfiguration",
  () => Effect.Effect<
    (
      request?: securityhub.DescribeOrganizationConfigurationRequest,
    ) => Effect.Effect<
      securityhub.DescribeOrganizationConfigurationResponse,
      securityhub.DescribeOrganizationConfigurationError
    >
  >
> {}
export const DescribeOrganizationConfiguration =
  Binding.Service<DescribeOrganizationConfiguration>(
    "AWS.SecurityHub.DescribeOrganizationConfiguration",
  );
