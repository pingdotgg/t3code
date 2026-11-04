import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Layer from "effect/Layer";
import { makeAccessAnalyzerAccountHttpBinding } from "./BindingHttp.ts";
import { StartPolicyGeneration } from "./StartPolicyGeneration.ts";

export const StartPolicyGenerationHttp = Layer.effect(
  StartPolicyGeneration,
  makeAccessAnalyzerAccountHttpBinding({
    tag: "AWS.AccessAnalyzer.StartPolicyGeneration",
    operation: aa.startPolicyGeneration,
    actions: ["access-analyzer:StartPolicyGeneration"],
  }),
);
