import * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import * as Layer from "effect/Layer";
import { makeIdentityCenterInstanceHttpBinding } from "./BindingHttp.ts";
import { ListPermissionSets } from "./ListPermissionSets.ts";

export const ListPermissionSetsHttp = Layer.effect(
  ListPermissionSets,
  makeIdentityCenterInstanceHttpBinding({
    tag: "AWS.IdentityCenter.ListPermissionSets",
    operation: ssoAdmin.listPermissionSets,
    actions: ["sso:ListPermissionSets"],
  }),
);
