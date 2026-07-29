import type * as r53r from "@distilled.cloud/aws/route53resolver";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ResolverRule } from "./ResolverRule.ts";

export interface UpdateResolverRuleRequest extends Omit<
  r53r.UpdateResolverRuleRequest,
  "ResolverRuleId"
> {}

/**
 * Runtime binding for `route53resolver:UpdateResolverRule` — update the
 * bound {@link ResolverRule}'s mutable configuration (name, target IPs,
 * outbound endpoint); the rule ID is injected automatically.
 *
 * The canonical runtime use: DNS failover automation — a Lambda health-checks
 * the on-premises resolvers a FORWARD rule targets and swaps `TargetIps` to
 * the healthy set when one goes dark.
 *
 * Provide `Route53Resolver.UpdateResolverRuleHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Updating Rules at Runtime
 * @example Fail Over the Rule's Target IPs
 * ```typescript
 * // init — grants route53resolver:UpdateResolverRule on the rule
 * const updateRule = yield* AWS.Route53Resolver.UpdateResolverRule(rule);
 *
 * // runtime
 * yield* updateRule({
 *   Config: { TargetIps: [{ Ip: "192.168.2.10", Port: 53 }] },
 * });
 * ```
 */
export interface UpdateResolverRule extends Binding.Service<
  UpdateResolverRule,
  "AWS.Route53Resolver.UpdateResolverRule",
  (
    rule: ResolverRule,
  ) => Effect.Effect<
    (
      request: UpdateResolverRuleRequest,
    ) => Effect.Effect<
      r53r.UpdateResolverRuleResponse,
      r53r.UpdateResolverRuleError
    >
  >
> {}

export const UpdateResolverRule = Binding.Service<UpdateResolverRule>(
  "AWS.Route53Resolver.UpdateResolverRule",
);
