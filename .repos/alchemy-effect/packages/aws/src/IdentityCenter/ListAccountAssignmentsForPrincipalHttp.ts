import * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import * as Layer from "effect/Layer";
import { makeIdentityCenterInstanceHttpBinding } from "./BindingHttp.ts";
import { ListAccountAssignmentsForPrincipal } from "./ListAccountAssignmentsForPrincipal.ts";

export const ListAccountAssignmentsForPrincipalHttp = Layer.effect(
  ListAccountAssignmentsForPrincipal,
  makeIdentityCenterInstanceHttpBinding({
    tag: "AWS.IdentityCenter.ListAccountAssignmentsForPrincipal",
    operation: ssoAdmin.listAccountAssignmentsForPrincipal,
    actions: ["sso:ListAccountAssignmentsForPrincipal"],
  }),
);
