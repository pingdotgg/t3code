import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { BatchGetAutomationRules } from "./BatchGetAutomationRules.ts";

export const BatchGetAutomationRulesHttp = Layer.effect(
  BatchGetAutomationRules,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.BatchGetAutomationRules",
    operation: securityhub.batchGetAutomationRules,
    actions: ["securityhub:BatchGetAutomationRules"],
  }),
);
