import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Layer from "effect/Layer";
import { makeAccessAnalyzerAccountHttpBinding } from "./BindingHttp.ts";
import { CancelPolicyGeneration } from "./CancelPolicyGeneration.ts";

export const CancelPolicyGenerationHttp = Layer.effect(
  CancelPolicyGeneration,
  makeAccessAnalyzerAccountHttpBinding({
    tag: "AWS.AccessAnalyzer.CancelPolicyGeneration",
    operation: aa.cancelPolicyGeneration,
    actions: ["access-analyzer:CancelPolicyGeneration"],
  }),
);
