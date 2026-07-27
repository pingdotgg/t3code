import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Layer from "effect/Layer";
import { makeAnalyzerScopedHttpBinding } from "./BindingHttp.ts";
import { ApplyArchiveRule } from "./ApplyArchiveRule.ts";

export const ApplyArchiveRuleHttp = Layer.effect(
  ApplyArchiveRule,
  makeAnalyzerScopedHttpBinding({
    tag: "AWS.AccessAnalyzer.ApplyArchiveRule",
    operation: aa.applyArchiveRule,
    actions: ["access-analyzer:ApplyArchiveRule"],
  }),
);
