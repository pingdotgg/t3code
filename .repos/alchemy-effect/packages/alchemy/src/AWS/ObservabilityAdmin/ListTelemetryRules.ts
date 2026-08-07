import type * as obs from "@distilled.cloud/aws/observabilityadmin";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `observabilityadmin:ListTelemetryRules` — enumerates
 * the account's telemetry rules (name, ARN, telemetry type, source types),
 * e.g. for an audit function that reports which auto-enable rules exist.
 *
 * Provide `AWS.ObservabilityAdmin.ListTelemetryRulesHttp` on the hosting
 * Lambda Function to satisfy the requirement.
 * @binding
 * @section Listing Telemetry Rules
 * @example Enumerate the account's telemetry rules
 * ```typescript
 * // init — grants observabilityadmin:ListTelemetryRules
 * const listTelemetryRules = yield* AWS.ObservabilityAdmin.ListTelemetryRules();
 *
 * // runtime
 * const { TelemetryRuleSummaries } = yield* listTelemetryRules();
 * for (const rule of TelemetryRuleSummaries ?? []) {
 *   yield* Effect.log(`${rule.RuleName}: ${rule.TelemetryType}`);
 * }
 * ```
 */
export interface ListTelemetryRules extends Binding.Service<
  ListTelemetryRules,
  "AWS.ObservabilityAdmin.ListTelemetryRules",
  () => Effect.Effect<
    (
      request?: obs.ListTelemetryRulesInput,
    ) => Effect.Effect<
      obs.ListTelemetryRulesOutput,
      obs.ListTelemetryRulesError
    >
  >
> {}

export const ListTelemetryRules = Binding.Service<ListTelemetryRules>(
  "AWS.ObservabilityAdmin.ListTelemetryRules",
);
