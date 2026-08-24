import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { GetFindingsStatistics } from "./GetFindingsStatistics.ts";

export const GetFindingsStatisticsHttp = Layer.effect(
  GetFindingsStatistics,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.GetFindingsStatistics",
    operation: guardduty.getFindingsStatistics,
    actions: ["guardduty:GetFindingsStatistics"],
  }),
);
