import * as detective from "@distilled.cloud/aws/detective";
import * as Layer from "effect/Layer";
import { makeDetectiveGraphHttpBinding } from "./BindingHttp.ts";
import { DescribeOrganizationConfiguration } from "./DescribeOrganizationConfiguration.ts";

export const DescribeOrganizationConfigurationHttp = Layer.effect(
  DescribeOrganizationConfiguration,
  makeDetectiveGraphHttpBinding({
    tag: "AWS.Detective.DescribeOrganizationConfiguration",
    operation: detective.describeOrganizationConfiguration,
    actions: ["detective:DescribeOrganizationConfiguration"],
  }),
);
