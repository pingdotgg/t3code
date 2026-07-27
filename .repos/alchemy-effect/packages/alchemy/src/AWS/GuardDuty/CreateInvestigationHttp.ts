import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { CreateInvestigation } from "./CreateInvestigation.ts";

export const CreateInvestigationHttp = Layer.effect(
  CreateInvestigation,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.CreateInvestigation",
    operation: guardduty.createInvestigation,
    actions: ["guardduty:CreateInvestigation"],
  }),
);
