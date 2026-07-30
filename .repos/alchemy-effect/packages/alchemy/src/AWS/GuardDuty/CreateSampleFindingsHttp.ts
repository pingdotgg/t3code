import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { CreateSampleFindings } from "./CreateSampleFindings.ts";

export const CreateSampleFindingsHttp = Layer.effect(
  CreateSampleFindings,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.CreateSampleFindings",
    operation: guardduty.createSampleFindings,
    actions: ["guardduty:CreateSampleFindings"],
  }),
);
