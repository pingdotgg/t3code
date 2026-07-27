import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { AcceptAdministratorInvitation } from "./AcceptAdministratorInvitation.ts";

export const AcceptAdministratorInvitationHttp = Layer.effect(
  AcceptAdministratorInvitation,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.AcceptAdministratorInvitation",
    operation: guardduty.acceptAdministratorInvitation,
    actions: ["guardduty:AcceptAdministratorInvitation"],
  }),
);
