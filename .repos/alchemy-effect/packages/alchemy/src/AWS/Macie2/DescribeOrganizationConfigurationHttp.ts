import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { DescribeOrganizationConfiguration } from "./DescribeOrganizationConfiguration.ts";

export const DescribeOrganizationConfigurationHttp = Layer.effect(
  DescribeOrganizationConfiguration,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.DescribeOrganizationConfiguration",
    operation: macie2.describeOrganizationConfiguration,
    actions: ["macie2:DescribeOrganizationConfiguration"],
  }),
);
