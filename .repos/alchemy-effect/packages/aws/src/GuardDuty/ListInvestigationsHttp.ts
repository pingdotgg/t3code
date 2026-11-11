import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { ListInvestigations } from "./ListInvestigations.ts";

export const ListInvestigationsHttp = Layer.effect(
  ListInvestigations,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.ListInvestigations",
    operation: guardduty.listInvestigations,
    actions: ["guardduty:ListInvestigations"],
  }),
);
