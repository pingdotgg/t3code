import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface DescribeAccountSettingsRequest
  extends Kinesis.DescribeAccountSettingsInput {}

/**
 * Runtime binding for `kinesis:DescribeAccountSettings`.
 *
 * An account-level operation (no stream argument) that reports the account's
 * Kinesis settings, such as on-demand stream count quotas. Provide the
 * implementation with `Effect.provide(AWS.Kinesis.DescribeAccountSettingsHttp)`.
 * @binding
 * @section Account Settings
 * @example Read the Account's Kinesis Settings
 * ```typescript
 * // init — account-level binding takes no resource
 * const describeAccountSettings = yield* AWS.Kinesis.DescribeAccountSettings();
 *
 * // runtime
 * const settings = yield* describeAccountSettings();
 * ```
 */
export interface DescribeAccountSettings extends Binding.Service<
  DescribeAccountSettings,
  "AWS.Kinesis.DescribeAccountSettings",
  () => Effect.Effect<
    (
      request?: DescribeAccountSettingsRequest,
    ) => Effect.Effect<
      Kinesis.DescribeAccountSettingsOutput,
      Kinesis.DescribeAccountSettingsError
    >
  >
> {}

export const DescribeAccountSettings = Binding.Service<DescribeAccountSettings>(
  "AWS.Kinesis.DescribeAccountSettings",
);
