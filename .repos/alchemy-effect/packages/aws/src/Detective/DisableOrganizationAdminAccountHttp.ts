import * as detective from "@distilled.cloud/aws/detective";
import * as Layer from "effect/Layer";
import { makeDetectiveAccountHttpBinding } from "./BindingHttp.ts";
import { DisableOrganizationAdminAccount } from "./DisableOrganizationAdminAccount.ts";

export const DisableOrganizationAdminAccountHttp = Layer.effect(
  DisableOrganizationAdminAccount,
  makeDetectiveAccountHttpBinding({
    tag: "AWS.Detective.DisableOrganizationAdminAccount",
    operation: detective.disableOrganizationAdminAccount,
    actions: ["detective:DisableOrganizationAdminAccount"],
  }),
);
