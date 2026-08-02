import * as wafv2 from "@distilled.cloud/aws/wafv2";
import * as Layer from "effect/Layer";
import { makeWafv2WebAclHttpBinding } from "./BindingHttp.ts";
import { GetTopPathStatisticsByTraffic } from "./GetTopPathStatisticsByTraffic.ts";

export const GetTopPathStatisticsByTrafficHttp = Layer.effect(
  GetTopPathStatisticsByTraffic,
  makeWafv2WebAclHttpBinding({
    tag: "AWS.WAFv2.GetTopPathStatisticsByTraffic",
    operation: wafv2.getTopPathStatisticsByTraffic,
    actions: ["wafv2:GetTopPathStatisticsByTraffic"],
    inject: (acl) => ({ WebAclArn: acl.arn, Scope: acl.scope }),
  }),
);
