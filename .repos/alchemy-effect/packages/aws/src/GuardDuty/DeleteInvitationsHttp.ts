import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyAccountHttpBinding } from "./BindingHttp.ts";
import { DeleteInvitations } from "./DeleteInvitations.ts";

export const DeleteInvitationsHttp = Layer.effect(
  DeleteInvitations,
  makeGuardDutyAccountHttpBinding({
    tag: "AWS.GuardDuty.DeleteInvitations",
    operation: guardduty.deleteInvitations,
    actions: ["guardduty:DeleteInvitations"],
  }),
);
