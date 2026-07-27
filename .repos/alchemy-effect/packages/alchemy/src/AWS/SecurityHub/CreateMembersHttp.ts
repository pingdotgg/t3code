import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { CreateMembers } from "./CreateMembers.ts";

export const CreateMembersHttp = Layer.effect(
  CreateMembers,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.CreateMembers",
    operation: securityhub.createMembers,
    actions: ["securityhub:CreateMembers"],
  }),
);
