import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { DeleteMembers } from "./DeleteMembers.ts";

export const DeleteMembersHttp = Layer.effect(
  DeleteMembers,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.DeleteMembers",
    operation: securityhub.deleteMembers,
    actions: ["securityhub:DeleteMembers"],
  }),
);
