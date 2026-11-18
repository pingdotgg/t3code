import * as r53r from "@distilled.cloud/aws/route53resolver";
import * as Layer from "effect/Layer";
import { makeRoute53ResolverRuleHttpBinding } from "./BindingHttp.ts";
import { UpdateResolverRule } from "./UpdateResolverRule.ts";

export const UpdateResolverRuleHttp = Layer.effect(
  UpdateResolverRule,
  makeRoute53ResolverRuleHttpBinding({
    tag: "AWS.Route53Resolver.UpdateResolverRule",
    operation: r53r.updateResolverRule,
    actions: ["route53resolver:UpdateResolverRule"],
  }),
);
