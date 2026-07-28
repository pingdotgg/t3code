import type * as r53r from "@distilled.cloud/aws/route53resolver";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ResolverRule } from "./ResolverRule.ts";

/**
 * Runtime binding for `route53resolver:GetResolverRule` — read the bound
 * {@link ResolverRule}'s live state (domain name, target IPs, endpoint,
 * status); the rule ID is injected automatically.
 *
 * Provide `Route53Resolver.GetResolverRuleHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Reading Rule State
 * @example Read the Rule's Target IPs
 * ```typescript
 * // init — grants route53resolver:GetResolverRule on the rule
 * const getRule = yield* AWS.Route53Resolver.GetResolverRule(rule);
 *
 * // runtime
 * const { ResolverRule } = yield* getRule();
 * const targets = (ResolverRule?.TargetIps ?? []).map((t) => t.Ip);
 * ```
 */
export interface GetResolverRule extends Binding.Service<
  GetResolverRule,
  "AWS.Route53Resolver.GetResolverRule",
  (
    rule: ResolverRule,
  ) => Effect.Effect<
    () => Effect.Effect<r53r.GetResolverRuleResponse, r53r.GetResolverRuleError>
  >
> {}

export const GetResolverRule = Binding.Service<GetResolverRule>(
  "AWS.Route53Resolver.GetResolverRule",
);
