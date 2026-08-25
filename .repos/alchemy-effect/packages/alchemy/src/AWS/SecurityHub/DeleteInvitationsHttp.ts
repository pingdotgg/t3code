import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { DeleteInvitations } from "./DeleteInvitations.ts";

export const DeleteInvitationsHttp = Layer.effect(
  DeleteInvitations,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.DeleteInvitations",
    operation: securityhub.deleteInvitations,
    actions: ["securityhub:DeleteInvitations"],
  }),
);
