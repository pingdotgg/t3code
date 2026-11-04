import * as config from "@distilled.cloud/aws/config-service";
import * as Layer from "effect/Layer";
import { makeConfigAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeComplianceByConfigRule } from "./DescribeComplianceByConfigRule.ts";

export const DescribeComplianceByConfigRuleHttp = Layer.effect(
  DescribeComplianceByConfigRule,
  makeConfigAccountHttpBinding({
    tag: "AWS.Config.DescribeComplianceByConfigRule",
    operation: config.describeComplianceByConfigRule,
    actions: ["config:DescribeComplianceByConfigRule"],
  }),
);
