import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { GetInsights } from "./GetInsights.ts";

export const GetInsightsHttp = Layer.effect(
  GetInsights,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.GetInsights",
    operation: securityhub.getInsights,
    actions: ["securityhub:GetInsights"],
  }),
);
