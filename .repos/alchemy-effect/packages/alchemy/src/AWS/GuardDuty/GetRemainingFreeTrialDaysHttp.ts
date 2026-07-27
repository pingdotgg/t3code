import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { GetRemainingFreeTrialDays } from "./GetRemainingFreeTrialDays.ts";

export const GetRemainingFreeTrialDaysHttp = Layer.effect(
  GetRemainingFreeTrialDays,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.GetRemainingFreeTrialDays",
    operation: guardduty.getRemainingFreeTrialDays,
    actions: ["guardduty:GetRemainingFreeTrialDays"],
  }),
);
