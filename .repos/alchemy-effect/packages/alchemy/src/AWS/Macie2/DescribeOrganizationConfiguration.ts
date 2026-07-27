import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:DescribeOrganizationConfiguration`.
 *
 * Retrieves the Amazon Macie configuration settings for an organization in Organizations.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.DescribeOrganizationConfigurationHttp)`.
 * @binding
 * @section Organization & Members
 * @example Read the Organization Configuration
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeOrganizationConfiguration = yield* AWS.Macie2.DescribeOrganizationConfiguration();
 *
 * // runtime
 * const { autoEnable } = yield* describeOrganizationConfiguration();
 * ```
 */
export interface DescribeOrganizationConfiguration extends Binding.Service<
  DescribeOrganizationConfiguration,
  "AWS.Macie2.DescribeOrganizationConfiguration",
  () => Effect.Effect<
    (
      request?: macie2.DescribeOrganizationConfigurationRequest,
    ) => Effect.Effect<
      macie2.DescribeOrganizationConfigurationResponse,
      macie2.DescribeOrganizationConfigurationError
    >
  >
> {}
export const DescribeOrganizationConfiguration =
  Binding.Service<DescribeOrganizationConfiguration>(
    "AWS.Macie2.DescribeOrganizationConfiguration",
  );
