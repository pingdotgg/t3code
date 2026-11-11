import * as config from "@distilled.cloud/aws/config-service";
import * as Layer from "effect/Layer";
import { makeConfigResourceHttpBinding } from "./BindingHttp.ts";
import type { ConfigRule } from "./ConfigRule.ts";
import { PutExternalEvaluation } from "./PutExternalEvaluation.ts";

export const PutExternalEvaluationHttp = Layer.effect(
  PutExternalEvaluation,
  makeConfigResourceHttpBinding({
    tag: "AWS.Config.PutExternalEvaluation",
    operation: config.putExternalEvaluation,
    actions: ["config:PutExternalEvaluation"],
    requestKey: "ConfigRuleName",
    identifier: (rule: ConfigRule) => rule.configRuleName,
  }),
);
