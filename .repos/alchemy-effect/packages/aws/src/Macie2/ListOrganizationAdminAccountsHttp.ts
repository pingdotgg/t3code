import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { ListOrganizationAdminAccounts } from "./ListOrganizationAdminAccounts.ts";

export const ListOrganizationAdminAccountsHttp = Layer.effect(
  ListOrganizationAdminAccounts,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.ListOrganizationAdminAccounts",
    operation: macie2.listOrganizationAdminAccounts,
    actions: ["macie2:ListOrganizationAdminAccounts"],
  }),
);
