import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { GetMembers } from "./GetMembers.ts";

export const GetMembersHttp = Layer.effect(
  GetMembers,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.GetMembers",
    operation: securityhub.getMembers,
    actions: ["securityhub:GetMembers"],
  }),
);
