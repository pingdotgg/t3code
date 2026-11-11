import * as config from "@distilled.cloud/aws/config-service";
import * as Layer from "effect/Layer";
import { makeConfigResourceHttpBinding } from "./BindingHttp.ts";
import type { ConfigRule } from "./ConfigRule.ts";
import { GetComplianceDetailsByConfigRule } from "./GetComplianceDetailsByConfigRule.ts";

export const GetComplianceDetailsByConfigRuleHttp = Layer.effect(
  GetComplianceDetailsByConfigRule,
  makeConfigResourceHttpBinding({
    tag: "AWS.Config.GetComplianceDetailsByConfigRule",
    operation: config.getComplianceDetailsByConfigRule,
    actions: ["config:GetComplianceDetailsByConfigRule"],
    requestKey: "ConfigRuleName",
    identifier: (rule: ConfigRule) => rule.configRuleName,
  }),
);
