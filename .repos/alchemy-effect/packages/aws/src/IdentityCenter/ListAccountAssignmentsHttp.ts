import * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import * as Layer from "effect/Layer";
import { makeIdentityCenterInstanceHttpBinding } from "./BindingHttp.ts";
import { ListAccountAssignments } from "./ListAccountAssignments.ts";

export const ListAccountAssignmentsHttp = Layer.effect(
  ListAccountAssignments,
  makeIdentityCenterInstanceHttpBinding({
    tag: "AWS.IdentityCenter.ListAccountAssignments",
    operation: ssoAdmin.listAccountAssignments,
    actions: ["sso:ListAccountAssignments"],
  }),
);
