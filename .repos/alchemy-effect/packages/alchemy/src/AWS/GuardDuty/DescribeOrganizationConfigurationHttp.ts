import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import { DescribeOrganizationConfiguration } from "./DescribeOrganizationConfiguration.ts";

export const DescribeOrganizationConfigurationHttp = Layer.effect(
  DescribeOrganizationConfiguration,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.DescribeOrganizationConfiguration",
    operation: guardduty.describeOrganizationConfiguration,
    actions: ["guardduty:DescribeOrganizationConfiguration"],
  }),
);
