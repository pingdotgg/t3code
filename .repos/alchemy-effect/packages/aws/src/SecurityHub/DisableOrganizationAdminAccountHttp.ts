import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { DisableOrganizationAdminAccount } from "./DisableOrganizationAdminAccount.ts";

export const DisableOrganizationAdminAccountHttp = Layer.effect(
  DisableOrganizationAdminAccount,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.DisableOrganizationAdminAccount",
    operation: securityhub.disableOrganizationAdminAccount,
    actions: ["securityhub:DisableOrganizationAdminAccount"],
  }),
);
