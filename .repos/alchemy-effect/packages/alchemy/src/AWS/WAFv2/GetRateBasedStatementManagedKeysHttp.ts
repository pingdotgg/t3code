import * as wafv2 from "@distilled.cloud/aws/wafv2";
import * as Layer from "effect/Layer";
import { makeWafv2WebAclHttpBinding } from "./BindingHttp.ts";
import { GetRateBasedStatementManagedKeys } from "./GetRateBasedStatementManagedKeys.ts";

export const GetRateBasedStatementManagedKeysHttp = Layer.effect(
  GetRateBasedStatementManagedKeys,
  makeWafv2WebAclHttpBinding({
    tag: "AWS.WAFv2.GetRateBasedStatementManagedKeys",
    operation: wafv2.getRateBasedStatementManagedKeys,
    actions: ["wafv2:GetRateBasedStatementManagedKeys"],
    inject: (acl) => ({
      Scope: acl.scope,
      WebACLName: acl.name,
      WebACLId: acl.id,
    }),
  }),
);
