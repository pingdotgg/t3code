import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { GetInvitationsCount } from "./GetInvitationsCount.ts";

export const GetInvitationsCountHttp = Layer.effect(
  GetInvitationsCount,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.GetInvitationsCount",
    operation: securityhub.getInvitationsCount,
    actions: ["securityhub:GetInvitationsCount"],
  }),
);
