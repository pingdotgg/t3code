import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { InviteMembers } from "./InviteMembers.ts";

export const InviteMembersHttp = Layer.effect(
  InviteMembers,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.InviteMembers",
    operation: guardduty.inviteMembers,
    actions: ["guardduty:InviteMembers"],
  }),
);
