import type * as r53r from "@distilled.cloud/aws/route53resolver";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ResolverRule } from "./ResolverRule.ts";

export interface ListResolverRuleAssociationsRequest extends Omit<
  r53r.ListResolverRuleAssociationsRequest,
  "Filters"
> {}

/**
 * Runtime binding for `route53resolver:ListResolverRuleAssociations` —
 * enumerate the VPC associations of the bound {@link ResolverRule}. The
 * request is automatically filtered to the bound rule
 * (`Filters: [{ Name: "ResolverRuleId", … }]`).
 *
 * Provide `Route53Resolver.ListResolverRuleAssociationsHttp` on the hosting
 * Lambda Function to satisfy the requirement.
 * @binding
 * @section Reading Rule State
 * @example List the VPCs a Rule Is Live In
 * ```typescript
 * // init — grants route53resolver:ListResolverRuleAssociations on the rule
 * const listAssociations = yield* AWS.Route53Resolver.ListResolverRuleAssociations(rule);
 *
 * // runtime
 * const { ResolverRuleAssociations } = yield* listAssociations();
 * const vpcIds = (ResolverRuleAssociations ?? []).map((a) => a.VPCId);
 * ```
 */
export interface ListResolverRuleAssociations extends Binding.Service<
  ListResolverRuleAssociations,
  "AWS.Route53Resolver.ListResolverRuleAssociations",
  (
    rule: ResolverRule,
  ) => Effect.Effect<
    (
      request?: ListResolverRuleAssociationsRequest,
    ) => Effect.Effect<
      r53r.ListResolverRuleAssociationsResponse,
      r53r.ListResolverRuleAssociationsError
    >
  >
> {}

export const ListResolverRuleAssociations =
  Binding.Service<ListResolverRuleAssociations>(
    "AWS.Route53Resolver.ListResolverRuleAssociations",
  );
