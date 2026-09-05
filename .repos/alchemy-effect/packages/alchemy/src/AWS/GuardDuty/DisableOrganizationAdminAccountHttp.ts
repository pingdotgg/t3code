import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyAccountHttpBinding } from "./BindingHttp.ts";
import { DisableOrganizationAdminAccount } from "./DisableOrganizationAdminAccount.ts";

export const DisableOrganizationAdminAccountHttp = Layer.effect(
  DisableOrganizationAdminAccount,
  makeGuardDutyAccountHttpBinding({
    tag: "AWS.GuardDuty.DisableOrganizationAdminAccount",
    operation: guardduty.disableOrganizationAdminAccount,
    actions: ["guardduty:DisableOrganizationAdminAccount"],
  }),
);
