import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { GetUsageStatistics } from "./GetUsageStatistics.ts";

export const GetUsageStatisticsHttp = Layer.effect(
  GetUsageStatistics,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.GetUsageStatistics",
    operation: guardduty.getUsageStatistics,
    actions: ["guardduty:GetUsageStatistics"],
  }),
);
