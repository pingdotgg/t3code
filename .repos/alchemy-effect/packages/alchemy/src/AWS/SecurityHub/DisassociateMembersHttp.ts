import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { DisassociateMembers } from "./DisassociateMembers.ts";

export const DisassociateMembersHttp = Layer.effect(
  DisassociateMembers,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.DisassociateMembers",
    operation: securityhub.disassociateMembers,
    actions: ["securityhub:DisassociateMembers"],
  }),
);
