import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { GetAdministratorAccount } from "./GetAdministratorAccount.ts";

export const GetAdministratorAccountHttp = Layer.effect(
  GetAdministratorAccount,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.GetAdministratorAccount",
    operation: guardduty.getAdministratorAccount,
    actions: ["guardduty:GetAdministratorAccount"],
  }),
);
