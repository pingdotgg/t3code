import type * as rbin from "@distilled.cloud/aws/rbin";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Rule } from "./Rule.ts";

/**
 * Runtime binding for `rbin:GetRule`.
 *
 * Reads the bound retention {@link Rule}'s full detail — retention period,
 * resource type, resource/exclusion tags, lock state, and status — so a
 * function can audit its Recycle Bin coverage or alert on an unexpected
 * unlock at runtime. The rule's identifier is injected from the binding.
 * Provide the implementation with `Effect.provide(AWS.Rbin.GetRuleHttp)`.
 * @binding
 * @section Reading Retention Rules
 * @example Check the bound rule's retention period
 * ```typescript
 * // init — grants rbin:GetRule on the rule's ARN
 * const getRule = yield* AWS.Rbin.GetRule(rule);
 *
 * // runtime
 * const detail = yield* getRule();
 * yield* Effect.log(
 *   `rule ${detail.Identifier} retains ${detail.ResourceType} for ` +
 *     `${detail.RetentionPeriod?.RetentionPeriodValue} days (${detail.LockState ?? "unlocked"})`,
 * );
 * ```
 */
export interface GetRule extends Binding.Service<
  GetRule,
  "AWS.Rbin.GetRule",
  (
    rule: Rule,
  ) => Effect.Effect<
    () => Effect.Effect<rbin.GetRuleResponse, rbin.GetRuleError>
  >
> {}
export const GetRule = Binding.Service<GetRule>("AWS.Rbin.GetRule");
