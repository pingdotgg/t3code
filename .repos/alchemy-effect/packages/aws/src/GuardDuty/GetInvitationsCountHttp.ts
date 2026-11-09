import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyAccountHttpBinding } from "./BindingHttp.ts";
import { GetInvitationsCount } from "./GetInvitationsCount.ts";

export const GetInvitationsCountHttp = Layer.effect(
  GetInvitationsCount,
  makeGuardDutyAccountHttpBinding({
    tag: "AWS.GuardDuty.GetInvitationsCount",
    operation: guardduty.getInvitationsCount,
    actions: ["guardduty:GetInvitationsCount"],
  }),
);
