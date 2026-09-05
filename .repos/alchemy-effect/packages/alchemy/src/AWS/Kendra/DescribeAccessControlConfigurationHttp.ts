import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";
import { DescribeAccessControlConfiguration } from "./DescribeAccessControlConfiguration.ts";

export const DescribeAccessControlConfigurationHttp = Layer.effect(
  DescribeAccessControlConfiguration,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.DescribeAccessControlConfiguration",
    operation: kendra.describeAccessControlConfiguration,
    actions: ["kendra:DescribeAccessControlConfiguration"],
    subResources: ["access-control-configuration/*"],
  }),
);
