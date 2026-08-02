import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { GetInsightResults } from "./GetInsightResults.ts";

export const GetInsightResultsHttp = Layer.effect(
  GetInsightResults,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.GetInsightResults",
    operation: securityhub.getInsightResults,
    actions: ["securityhub:GetInsightResults"],
  }),
);
