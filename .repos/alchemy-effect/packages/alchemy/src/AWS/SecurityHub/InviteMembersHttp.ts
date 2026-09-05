import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { InviteMembers } from "./InviteMembers.ts";

export const InviteMembersHttp = Layer.effect(
  InviteMembers,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.InviteMembers",
    operation: securityhub.inviteMembers,
    actions: ["securityhub:InviteMembers"],
  }),
);
