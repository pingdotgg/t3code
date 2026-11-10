import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { ListOrganizationAdminAccounts } from "./ListOrganizationAdminAccounts.ts";

export const ListOrganizationAdminAccountsHttp = Layer.effect(
  ListOrganizationAdminAccounts,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.ListOrganizationAdminAccounts",
    operation: securityhub.listOrganizationAdminAccounts,
    actions: ["securityhub:ListOrganizationAdminAccounts"],
  }),
);
