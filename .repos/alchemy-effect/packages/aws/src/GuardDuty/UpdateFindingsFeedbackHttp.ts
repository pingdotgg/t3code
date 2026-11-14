import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { UpdateFindingsFeedback } from "./UpdateFindingsFeedback.ts";

export const UpdateFindingsFeedbackHttp = Layer.effect(
  UpdateFindingsFeedback,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.UpdateFindingsFeedback",
    operation: guardduty.updateFindingsFeedback,
    actions: ["guardduty:UpdateFindingsFeedback"],
  }),
);
