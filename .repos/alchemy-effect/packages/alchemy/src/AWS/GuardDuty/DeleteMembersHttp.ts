import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { DeleteMembers } from "./DeleteMembers.ts";

export const DeleteMembersHttp = Layer.effect(
  DeleteMembers,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.DeleteMembers",
    operation: guardduty.deleteMembers,
    actions: ["guardduty:DeleteMembers"],
  }),
);
