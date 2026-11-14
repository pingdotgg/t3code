import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { ListCoverage } from "./ListCoverage.ts";

export const ListCoverageHttp = Layer.effect(
  ListCoverage,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.ListCoverage",
    operation: guardduty.listCoverage,
    actions: ["guardduty:ListCoverage"],
    // One of the two GuardDuty actions that supports resource-level
    // permissions on the detector ARN.
    resourceLevel: true,
  }),
);
