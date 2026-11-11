import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Layer from "effect/Layer";
import { makeAccessAnalyzerAccountHttpBinding } from "./BindingHttp.ts";
import { CheckAccessNotGranted } from "./CheckAccessNotGranted.ts";

export const CheckAccessNotGrantedHttp = Layer.effect(
  CheckAccessNotGranted,
  makeAccessAnalyzerAccountHttpBinding({
    tag: "AWS.AccessAnalyzer.CheckAccessNotGranted",
    operation: aa.checkAccessNotGranted,
    actions: ["access-analyzer:CheckAccessNotGranted"],
  }),
);
