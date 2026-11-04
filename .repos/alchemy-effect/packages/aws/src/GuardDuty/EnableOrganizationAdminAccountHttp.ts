import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyAccountHttpBinding } from "./BindingHttp.ts";
import { EnableOrganizationAdminAccount } from "./EnableOrganizationAdminAccount.ts";

export const EnableOrganizationAdminAccountHttp = Layer.effect(
  EnableOrganizationAdminAccount,
  makeGuardDutyAccountHttpBinding({
    tag: "AWS.GuardDuty.EnableOrganizationAdminAccount",
    operation: guardduty.enableOrganizationAdminAccount,
    actions: ["guardduty:EnableOrganizationAdminAccount"],
  }),
);
