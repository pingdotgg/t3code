import * as wafv2 from "@distilled.cloud/aws/wafv2";
import * as Layer from "effect/Layer";
import { makeWafv2RuleGroupHttpBinding } from "./BindingHttp.ts";
import { PutPermissionPolicy } from "./PutPermissionPolicy.ts";

export const PutPermissionPolicyHttp = Layer.effect(
  PutPermissionPolicy,
  makeWafv2RuleGroupHttpBinding({
    tag: "AWS.WAFv2.PutPermissionPolicy",
    operation: wafv2.putPermissionPolicy,
    actions: ["wafv2:PutPermissionPolicy"],
  }),
);
