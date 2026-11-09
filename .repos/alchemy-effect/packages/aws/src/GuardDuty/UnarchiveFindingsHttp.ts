import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { UnarchiveFindings } from "./UnarchiveFindings.ts";

export const UnarchiveFindingsHttp = Layer.effect(
  UnarchiveFindings,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.UnarchiveFindings",
    operation: guardduty.unarchiveFindings,
    actions: ["guardduty:UnarchiveFindings"],
  }),
);
