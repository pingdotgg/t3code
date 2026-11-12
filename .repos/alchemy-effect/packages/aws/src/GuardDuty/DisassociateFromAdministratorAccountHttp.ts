import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { DisassociateFromAdministratorAccount } from "./DisassociateFromAdministratorAccount.ts";

export const DisassociateFromAdministratorAccountHttp = Layer.effect(
  DisassociateFromAdministratorAccount,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.DisassociateFromAdministratorAccount",
    operation: guardduty.disassociateFromAdministratorAccount,
    actions: ["guardduty:DisassociateFromAdministratorAccount"],
  }),
);
