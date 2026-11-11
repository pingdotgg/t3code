import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { DeclineInvitations } from "./DeclineInvitations.ts";

export const DeclineInvitationsHttp = Layer.effect(
  DeclineInvitations,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.DeclineInvitations",
    operation: securityhub.declineInvitations,
    actions: ["securityhub:DeclineInvitations"],
  }),
);
