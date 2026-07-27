import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:DescribeOrganizationConfiguration`.
 *
 * Describe Amazon Inspector configuration settings for an Amazon Web Services organization.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.DescribeOrganizationConfigurationHttp)`.
 * @binding
 * @section Organization & Members
 * @example Read Organization Auto-Enable Settings
 * ```typescript
 * // init
 * const describeOrganizationConfiguration = yield* AWS.Inspector2.DescribeOrganizationConfiguration();
 *
 * // runtime
 * const { autoEnable } = yield* describeOrganizationConfiguration();
 * ```
 */
export interface DescribeOrganizationConfiguration extends Binding.Service<
  DescribeOrganizationConfiguration,
  "AWS.Inspector2.DescribeOrganizationConfiguration",
  () => Effect.Effect<
    (
      request: inspector2.DescribeOrganizationConfigurationRequest,
    ) => Effect.Effect<
      inspector2.DescribeOrganizationConfigurationResponse,
      inspector2.DescribeOrganizationConfigurationError
    >
  >
> {}
export const DescribeOrganizationConfiguration =
  Binding.Service<DescribeOrganizationConfiguration>(
    "AWS.Inspector2.DescribeOrganizationConfiguration",
  );
