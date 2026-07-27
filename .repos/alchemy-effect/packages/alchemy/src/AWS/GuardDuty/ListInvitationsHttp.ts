import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyAccountHttpBinding } from "./BindingHttp.ts";
import { ListInvitations } from "./ListInvitations.ts";

export const ListInvitationsHttp = Layer.effect(
  ListInvitations,
  makeGuardDutyAccountHttpBinding({
    tag: "AWS.GuardDuty.ListInvitations",
    operation: guardduty.listInvitations,
    actions: ["guardduty:ListInvitations"],
  }),
);
