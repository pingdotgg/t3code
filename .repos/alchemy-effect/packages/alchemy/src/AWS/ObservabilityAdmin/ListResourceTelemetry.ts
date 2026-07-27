import type * as obs from "@distilled.cloud/aws/observabilityadmin";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `observabilityadmin:ListResourceTelemetry` — audits
 * which AWS resources (VPCs, Lambda functions, ...) have telemetry such as
 * flow logs configured, and in what state. The account-level telemetry
 * config data plane; requires the account to be onboarded (see
 * `ObservabilityAdmin.TelemetryConfig`).
 *
 * Provide `AWS.ObservabilityAdmin.ListResourceTelemetryHttp` on the hosting
 * Lambda Function to satisfy the requirement.
 *
 * Known platform quirk (observed 2026-07): the service's authorization for
 * this action can reject callers whose grant comes from an inline role
 * policy (even `observabilityadmin:*` on `Resource: "*"`) with a typed
 * `AccessDeniedException`, while principals with managed policies succeed.
 * Handle the typed tag until AWS fixes the action's auth integration.
 * @binding
 * @section Auditing Resource Telemetry
 * @example Find VPCs without flow logs
 * ```typescript
 * // init — grants observabilityadmin:ListResourceTelemetry
 * const listResourceTelemetry = yield* AWS.ObservabilityAdmin.ListResourceTelemetry();
 *
 * // runtime
 * const { TelemetryConfigurations } = yield* listResourceTelemetry({
 *   ResourceTypes: ["AWS::EC2::VPC"],
 *   TelemetryConfigurationState: { Logs: "NotEnabled" },
 * });
 * ```
 */
export interface ListResourceTelemetry extends Binding.Service<
  ListResourceTelemetry,
  "AWS.ObservabilityAdmin.ListResourceTelemetry",
  () => Effect.Effect<
    (
      request?: obs.ListResourceTelemetryInput,
    ) => Effect.Effect<
      obs.ListResourceTelemetryOutput,
      obs.ListResourceTelemetryError
    >
  >
> {}

export const ListResourceTelemetry = Binding.Service<ListResourceTelemetry>(
  "AWS.ObservabilityAdmin.ListResourceTelemetry",
);
