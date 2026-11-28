import * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import * as Layer from "effect/Layer";
import { makeIdentityCenterInstanceHttpBinding } from "./BindingHttp.ts";
import { DescribePermissionSet } from "./DescribePermissionSet.ts";

export const DescribePermissionSetHttp = Layer.effect(
  DescribePermissionSet,
  makeIdentityCenterInstanceHttpBinding({
    tag: "AWS.IdentityCenter.DescribePermissionSet",
    operation: ssoAdmin.describePermissionSet,
    actions: ["sso:DescribePermissionSet"],
  }),
);
