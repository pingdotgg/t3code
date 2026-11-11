import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Layer from "effect/Layer";
import { makeAccessAnalyzerAccountHttpBinding } from "./BindingHttp.ts";
import { CheckNoPublicAccess } from "./CheckNoPublicAccess.ts";

export const CheckNoPublicAccessHttp = Layer.effect(
  CheckNoPublicAccess,
  makeAccessAnalyzerAccountHttpBinding({
    tag: "AWS.AccessAnalyzer.CheckNoPublicAccess",
    operation: aa.checkNoPublicAccess,
    actions: ["access-analyzer:CheckNoPublicAccess"],
  }),
);
