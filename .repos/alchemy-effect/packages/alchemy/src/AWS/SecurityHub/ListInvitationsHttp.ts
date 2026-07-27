import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { ListInvitations } from "./ListInvitations.ts";

export const ListInvitationsHttp = Layer.effect(
  ListInvitations,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.ListInvitations",
    operation: securityhub.listInvitations,
    actions: ["securityhub:ListInvitations"],
  }),
);
