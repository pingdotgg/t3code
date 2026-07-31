import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { GetFindings } from "./GetFindings.ts";

export const GetFindingsHttp = Layer.effect(
  GetFindings,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.GetFindings",
    operation: securityhub.getFindings,
    actions: ["securityhub:GetFindings"],
  }),
);
