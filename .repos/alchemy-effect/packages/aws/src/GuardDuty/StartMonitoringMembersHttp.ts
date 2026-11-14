import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { StartMonitoringMembers } from "./StartMonitoringMembers.ts";

export const StartMonitoringMembersHttp = Layer.effect(
  StartMonitoringMembers,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.StartMonitoringMembers",
    operation: guardduty.startMonitoringMembers,
    actions: ["guardduty:StartMonitoringMembers"],
  }),
);
