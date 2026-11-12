import * as config from "@distilled.cloud/aws/config-service";
import * as Layer from "effect/Layer";
import { makeConfigAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeConfigRuleEvaluationStatus } from "./DescribeConfigRuleEvaluationStatus.ts";

export const DescribeConfigRuleEvaluationStatusHttp = Layer.effect(
  DescribeConfigRuleEvaluationStatus,
  makeConfigAccountHttpBinding({
    tag: "AWS.Config.DescribeConfigRuleEvaluationStatus",
    operation: config.describeConfigRuleEvaluationStatus,
    actions: ["config:DescribeConfigRuleEvaluationStatus"],
  }),
);
