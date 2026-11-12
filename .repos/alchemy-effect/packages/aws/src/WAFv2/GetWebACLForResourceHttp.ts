import * as wafv2 from "@distilled.cloud/aws/wafv2";
import * as Layer from "effect/Layer";
import { makeWafv2AccountHttpBinding } from "./BindingHttp.ts";
import { GetWebACLForResource } from "./GetWebACLForResource.ts";

export const GetWebACLForResourceHttp = Layer.effect(
  GetWebACLForResource,
  makeWafv2AccountHttpBinding({
    tag: "AWS.WAFv2.GetWebACLForResource",
    operation: wafv2.getWebACLForResource,
    // GetWebACLForResource authorizes against the protected resource's ARN
    // (unknowable at deploy time) and internally requires GetWebACL.
    actions: ["wafv2:GetWebACLForResource", "wafv2:GetWebACL"],
  }),
);
