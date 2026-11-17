import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { GetFindingHistory } from "./GetFindingHistory.ts";

export const GetFindingHistoryHttp = Layer.effect(
  GetFindingHistory,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.GetFindingHistory",
    operation: securityhub.getFindingHistory,
    actions: ["securityhub:GetFindingHistory"],
  }),
);
