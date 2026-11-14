import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { BatchGetAutomationRules } from "./BatchGetAutomationRules.ts";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";

export const BatchGetAutomationRulesHttp = Layer.effect(
  BatchGetAutomationRules,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.BatchGetAutomationRules",
    operation: securityhub.batchGetAutomationRules,
    actions: ["securityhub:BatchGetAutomationRules"],
  }),
);
