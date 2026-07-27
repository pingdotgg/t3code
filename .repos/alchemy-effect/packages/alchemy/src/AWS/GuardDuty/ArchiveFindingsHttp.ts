import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { ArchiveFindings } from "./ArchiveFindings.ts";

export const ArchiveFindingsHttp = Layer.effect(
  ArchiveFindings,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.ArchiveFindings",
    operation: guardduty.archiveFindings,
    actions: ["guardduty:ArchiveFindings"],
  }),
);
