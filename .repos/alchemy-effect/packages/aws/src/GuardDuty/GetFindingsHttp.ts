import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { GetFindings } from "./GetFindings.ts";

export const GetFindingsHttp = Layer.effect(
  GetFindings,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.GetFindings",
    operation: guardduty.getFindings,
    actions: ["guardduty:GetFindings"],
  }),
);
