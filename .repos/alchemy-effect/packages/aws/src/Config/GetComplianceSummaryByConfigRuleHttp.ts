import * as config from "@distilled.cloud/aws/config-service";
import * as Layer from "effect/Layer";
import { makeConfigAccountHttpBinding } from "./BindingHttp.ts";
import { GetComplianceSummaryByConfigRule } from "./GetComplianceSummaryByConfigRule.ts";

export const GetComplianceSummaryByConfigRuleHttp = Layer.effect(
  GetComplianceSummaryByConfigRule,
  makeConfigAccountHttpBinding({
    tag: "AWS.Config.GetComplianceSummaryByConfigRule",
    operation: config.getComplianceSummaryByConfigRule,
    actions: ["config:GetComplianceSummaryByConfigRule"],
  }),
);
