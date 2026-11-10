import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { GetInvestigation } from "./GetInvestigation.ts";

export const GetInvestigationHttp = Layer.effect(
  GetInvestigation,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.GetInvestigation",
    operation: guardduty.getInvestigation,
    actions: ["guardduty:GetInvestigation"],
  }),
);
