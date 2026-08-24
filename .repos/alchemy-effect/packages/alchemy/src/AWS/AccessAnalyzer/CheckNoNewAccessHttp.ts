import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Layer from "effect/Layer";
import { makeAccessAnalyzerAccountHttpBinding } from "./BindingHttp.ts";
import { CheckNoNewAccess } from "./CheckNoNewAccess.ts";

export const CheckNoNewAccessHttp = Layer.effect(
  CheckNoNewAccess,
  makeAccessAnalyzerAccountHttpBinding({
    tag: "AWS.AccessAnalyzer.CheckNoNewAccess",
    operation: aa.checkNoNewAccess,
    actions: ["access-analyzer:CheckNoNewAccess"],
  }),
);
