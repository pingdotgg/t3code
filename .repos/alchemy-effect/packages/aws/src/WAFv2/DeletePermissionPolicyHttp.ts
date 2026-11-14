import * as wafv2 from "@distilled.cloud/aws/wafv2";
import * as Layer from "effect/Layer";
import { makeWafv2RuleGroupHttpBinding } from "./BindingHttp.ts";
import { DeletePermissionPolicy } from "./DeletePermissionPolicy.ts";

export const DeletePermissionPolicyHttp = Layer.effect(
  DeletePermissionPolicy,
  makeWafv2RuleGroupHttpBinding({
    tag: "AWS.WAFv2.DeletePermissionPolicy",
    operation: wafv2.deletePermissionPolicy,
    actions: ["wafv2:DeletePermissionPolicy"],
  }),
);
