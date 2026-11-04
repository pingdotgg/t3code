import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { DisableOrganizationAdminAccount } from "./DisableOrganizationAdminAccount.ts";

export const DisableOrganizationAdminAccountHttp = Layer.effect(
  DisableOrganizationAdminAccount,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.DisableOrganizationAdminAccount",
    operation: macie2.disableOrganizationAdminAccount,
    actions: ["macie2:DisableOrganizationAdminAccount"],
  }),
);
