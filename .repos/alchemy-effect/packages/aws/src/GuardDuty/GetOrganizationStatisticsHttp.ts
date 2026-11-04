import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyAccountHttpBinding } from "./BindingHttp.ts";
import { GetOrganizationStatistics } from "./GetOrganizationStatistics.ts";

export const GetOrganizationStatisticsHttp = Layer.effect(
  GetOrganizationStatistics,
  makeGuardDutyAccountHttpBinding({
    tag: "AWS.GuardDuty.GetOrganizationStatistics",
    operation: guardduty.getOrganizationStatistics,
    actions: ["guardduty:GetOrganizationStatistics"],
  }),
);
