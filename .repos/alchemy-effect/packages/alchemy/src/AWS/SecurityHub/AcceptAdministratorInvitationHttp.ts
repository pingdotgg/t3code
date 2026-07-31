import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { AcceptAdministratorInvitation } from "./AcceptAdministratorInvitation.ts";

export const AcceptAdministratorInvitationHttp = Layer.effect(
  AcceptAdministratorInvitation,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.AcceptAdministratorInvitation",
    operation: securityhub.acceptAdministratorInvitation,
    actions: ["securityhub:AcceptAdministratorInvitation"],
  }),
);
