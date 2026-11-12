import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { DisassociateMembers } from "./DisassociateMembers.ts";

export const DisassociateMembersHttp = Layer.effect(
  DisassociateMembers,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.DisassociateMembers",
    operation: guardduty.disassociateMembers,
    actions: ["guardduty:DisassociateMembers"],
  }),
);
