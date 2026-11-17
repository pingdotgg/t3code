import * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import * as Layer from "effect/Layer";
import { makeIdentityCenterInstanceHttpBinding } from "./BindingHttp.ts";
import { ListAccountsForProvisionedPermissionSet } from "./ListAccountsForProvisionedPermissionSet.ts";

export const ListAccountsForProvisionedPermissionSetHttp = Layer.effect(
  ListAccountsForProvisionedPermissionSet,
  makeIdentityCenterInstanceHttpBinding({
    tag: "AWS.IdentityCenter.ListAccountsForProvisionedPermissionSet",
    operation: ssoAdmin.listAccountsForProvisionedPermissionSet,
    actions: ["sso:ListAccountsForProvisionedPermissionSet"],
  }),
);
