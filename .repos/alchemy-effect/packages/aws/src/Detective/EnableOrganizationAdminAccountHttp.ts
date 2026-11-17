import * as detective from "@distilled.cloud/aws/detective";
import * as Layer from "effect/Layer";
import { makeDetectiveAccountHttpBinding } from "./BindingHttp.ts";
import { EnableOrganizationAdminAccount } from "./EnableOrganizationAdminAccount.ts";

export const EnableOrganizationAdminAccountHttp = Layer.effect(
  EnableOrganizationAdminAccount,
  makeDetectiveAccountHttpBinding({
    tag: "AWS.Detective.EnableOrganizationAdminAccount",
    operation: detective.enableOrganizationAdminAccount,
    actions: ["detective:EnableOrganizationAdminAccount"],
  }),
);
