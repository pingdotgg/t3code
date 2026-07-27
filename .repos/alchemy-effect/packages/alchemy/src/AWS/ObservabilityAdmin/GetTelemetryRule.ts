import type * as obs from "@distilled.cloud/aws/observabilityadmin";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { TelemetryRule } from "./TelemetryRule.ts";

/**
 * Runtime binding for `observabilityadmin:GetTelemetryRule` — reads the full
 * configuration and per-region status of the bound
 * {@link TelemetryRule}. The rule's name is injected automatically and the
 * IAM grant is scoped to the rule's ARN.
 *
 * Provide `AWS.ObservabilityAdmin.GetTelemetryRuleHttp` on the hosting
 * Lambda Function to satisfy the requirement.
 * @binding
 * @section Reading a Telemetry Rule
 * @example Read the bound rule's configuration
 * ```typescript
 * // init — grants observabilityadmin:GetTelemetryRule on the rule
 * const getTelemetryRule = yield* AWS.ObservabilityAdmin.GetTelemetryRule(rule);
 *
 * // runtime
 * const { TelemetryRule: config, RegionStatuses } = yield* getTelemetryRule();
 * ```
 */
export interface GetTelemetryRule extends Binding.Service<
  GetTelemetryRule,
  "AWS.ObservabilityAdmin.GetTelemetryRule",
  (
    rule: TelemetryRule,
  ) => Effect.Effect<
    () => Effect.Effect<obs.GetTelemetryRuleOutput, obs.GetTelemetryRuleError>
  >
> {}

export const GetTelemetryRule = Binding.Service<GetTelemetryRule>(
  "AWS.ObservabilityAdmin.GetTelemetryRule",
);
