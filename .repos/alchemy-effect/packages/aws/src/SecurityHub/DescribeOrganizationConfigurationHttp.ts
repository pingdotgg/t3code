import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { DescribeOrganizationConfiguration } from "./DescribeOrganizationConfiguration.ts";

export const DescribeOrganizationConfigurationHttp = Layer.effect(
  DescribeOrganizationConfiguration,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.DescribeOrganizationConfiguration",
    operation: securityhub.describeOrganizationConfiguration,
    actions: ["securityhub:DescribeOrganizationConfiguration"],
  }),
);
