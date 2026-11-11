import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { UpdateMemberDetectors } from "./UpdateMemberDetectors.ts";

export const UpdateMemberDetectorsHttp = Layer.effect(
  UpdateMemberDetectors,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.UpdateMemberDetectors",
    operation: guardduty.updateMemberDetectors,
    actions: ["guardduty:UpdateMemberDetectors"],
  }),
);
