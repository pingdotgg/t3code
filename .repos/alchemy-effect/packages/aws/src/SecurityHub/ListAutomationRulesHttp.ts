import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { ListAutomationRules } from "./ListAutomationRules.ts";

export const ListAutomationRulesHttp = Layer.effect(
  ListAutomationRules,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.ListAutomationRules",
    operation: securityhub.listAutomationRules,
    actions: ["securityhub:ListAutomationRules"],
  }),
);
