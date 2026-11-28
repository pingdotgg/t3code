import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { ListMembers } from "./ListMembers.ts";

export const ListMembersHttp = Layer.effect(
  ListMembers,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.ListMembers",
    operation: securityhub.listMembers,
    actions: ["securityhub:ListMembers"],
  }),
);
