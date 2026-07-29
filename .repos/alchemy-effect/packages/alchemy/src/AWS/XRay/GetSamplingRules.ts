import type * as xray from "@distilled.cloud/aws/xray";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetSamplingRulesRequest extends xray.GetSamplingRulesRequest {}

/**
 * Retrieve all X-Ray sampling rules — the first half of the sampling
 * protocol used by custom samplers (poll rules, then report statistics
 * via `GetSamplingTargets`).
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetSamplingRulesHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetSamplingRules`, so the binding grants it on `*`.
 * @binding
 * @section Sampling
 * @example Poll the active sampling rules
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * // init — grants xray:GetSamplingRules
 * const getSamplingRules = yield* XRay.GetSamplingRules();
 *
 * // runtime
 * const rules = yield* getSamplingRules();
 * const names = (rules.SamplingRuleRecords ?? []).map(
 *   (record) => record.SamplingRule?.RuleName,
 * );
 * ```
 */
export interface GetSamplingRules extends Binding.Service<
  GetSamplingRules,
  "AWS.XRay.GetSamplingRules",
  () => Effect.Effect<
    (
      request?: GetSamplingRulesRequest,
    ) => Effect.Effect<xray.GetSamplingRulesResult, xray.GetSamplingRulesError>
  >
> {}
export const GetSamplingRules = Binding.Service<GetSamplingRules>(
  "AWS.XRay.GetSamplingRules",
);
