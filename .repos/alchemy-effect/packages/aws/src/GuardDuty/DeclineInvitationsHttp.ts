import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyAccountHttpBinding } from "./BindingHttp.ts";
import { DeclineInvitations } from "./DeclineInvitations.ts";

export const DeclineInvitationsHttp = Layer.effect(
  DeclineInvitations,
  makeGuardDutyAccountHttpBinding({
    tag: "AWS.GuardDuty.DeclineInvitations",
    operation: guardduty.declineInvitations,
    actions: ["guardduty:DeclineInvitations"],
  }),
);
