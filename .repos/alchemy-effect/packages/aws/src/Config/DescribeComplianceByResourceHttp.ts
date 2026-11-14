import * as config from "@distilled.cloud/aws/config-service";
import * as Layer from "effect/Layer";
import { makeConfigAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeComplianceByResource } from "./DescribeComplianceByResource.ts";

export const DescribeComplianceByResourceHttp = Layer.effect(
  DescribeComplianceByResource,
  makeConfigAccountHttpBinding({
    tag: "AWS.Config.DescribeComplianceByResource",
    operation: config.describeComplianceByResource,
    actions: ["config:DescribeComplianceByResource"],
  }),
);
