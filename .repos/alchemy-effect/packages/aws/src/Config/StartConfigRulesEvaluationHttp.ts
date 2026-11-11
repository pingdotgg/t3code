import * as config from "@distilled.cloud/aws/config-service";
import * as Layer from "effect/Layer";
import { makeConfigResourceHttpBinding } from "./BindingHttp.ts";
import type { ConfigRule } from "./ConfigRule.ts";
import { StartConfigRulesEvaluation } from "./StartConfigRulesEvaluation.ts";

export const StartConfigRulesEvaluationHttp = Layer.effect(
  StartConfigRulesEvaluation,
  makeConfigResourceHttpBinding({
    tag: "AWS.Config.StartConfigRulesEvaluation",
    operation: config.startConfigRulesEvaluation,
    actions: ["config:StartConfigRulesEvaluation"],
    requestKey: "ConfigRuleNames",
    asList: true,
    identifier: (rule: ConfigRule) => rule.configRuleName,
  }),
);
