import * as detective from "@distilled.cloud/aws/detective";
import * as Layer from "effect/Layer";
import { makeDetectiveGraphHttpBinding } from "./BindingHttp.ts";
import { StartMonitoringMember } from "./StartMonitoringMember.ts";

export const StartMonitoringMemberHttp = Layer.effect(
  StartMonitoringMember,
  makeDetectiveGraphHttpBinding({
    tag: "AWS.Detective.StartMonitoringMember",
    operation: detective.startMonitoringMember,
    actions: ["detective:StartMonitoringMember"],
  }),
);
