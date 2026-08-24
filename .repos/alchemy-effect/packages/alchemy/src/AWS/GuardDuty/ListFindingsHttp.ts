import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { ListFindings } from "./ListFindings.ts";

export const ListFindingsHttp = Layer.effect(
  ListFindings,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.ListFindings",
    operation: guardduty.listFindings,
    actions: ["guardduty:ListFindings"],
  }),
);
