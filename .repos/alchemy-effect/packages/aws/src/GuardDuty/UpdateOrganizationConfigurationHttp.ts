import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { UpdateOrganizationConfiguration } from "./UpdateOrganizationConfiguration.ts";

export const UpdateOrganizationConfigurationHttp = Layer.effect(
  UpdateOrganizationConfiguration,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.UpdateOrganizationConfiguration",
    operation: guardduty.updateOrganizationConfiguration,
    actions: ["guardduty:UpdateOrganizationConfiguration"],
  }),
);
