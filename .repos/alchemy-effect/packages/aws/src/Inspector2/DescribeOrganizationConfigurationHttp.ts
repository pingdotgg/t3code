import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { DescribeOrganizationConfiguration } from "./DescribeOrganizationConfiguration.ts";

export const DescribeOrganizationConfigurationHttp = Layer.effect(
  DescribeOrganizationConfiguration,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.DescribeOrganizationConfiguration",
    operation: inspector2.describeOrganizationConfiguration,
    actions: ["inspector2:DescribeOrganizationConfiguration"],
  }),
);
