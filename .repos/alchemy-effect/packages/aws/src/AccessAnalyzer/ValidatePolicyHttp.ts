import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Layer from "effect/Layer";
import { makeAccessAnalyzerAccountHttpBinding } from "./BindingHttp.ts";
import { ValidatePolicy } from "./ValidatePolicy.ts";

export const ValidatePolicyHttp = Layer.effect(
  ValidatePolicy,
  makeAccessAnalyzerAccountHttpBinding({
    tag: "AWS.AccessAnalyzer.ValidatePolicy",
    operation: aa.validatePolicy,
    actions: ["access-analyzer:ValidatePolicy"],
  }),
);
