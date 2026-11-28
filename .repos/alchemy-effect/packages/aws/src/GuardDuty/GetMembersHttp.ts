import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { GetMembers } from "./GetMembers.ts";

export const GetMembersHttp = Layer.effect(
  GetMembers,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.GetMembers",
    operation: guardduty.getMembers,
    actions: ["guardduty:GetMembers"],
  }),
);
