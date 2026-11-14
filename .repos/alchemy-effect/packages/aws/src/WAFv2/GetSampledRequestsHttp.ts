import * as wafv2 from "@distilled.cloud/aws/wafv2";
import * as Layer from "effect/Layer";
import { makeWafv2WebAclHttpBinding } from "./BindingHttp.ts";
import { GetSampledRequests } from "./GetSampledRequests.ts";

export const GetSampledRequestsHttp = Layer.effect(
  GetSampledRequests,
  makeWafv2WebAclHttpBinding({
    tag: "AWS.WAFv2.GetSampledRequests",
    operation: wafv2.getSampledRequests,
    actions: ["wafv2:GetSampledRequests"],
    inject: (acl) => ({ WebAclArn: acl.arn, Scope: acl.scope }),
  }),
);
