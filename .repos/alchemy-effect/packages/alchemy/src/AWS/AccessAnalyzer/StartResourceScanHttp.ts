import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Layer from "effect/Layer";
import { makeAnalyzerScopedHttpBinding } from "./BindingHttp.ts";
import { StartResourceScan } from "./StartResourceScan.ts";

export const StartResourceScanHttp = Layer.effect(
  StartResourceScan,
  makeAnalyzerScopedHttpBinding({
    tag: "AWS.AccessAnalyzer.StartResourceScan",
    operation: aa.startResourceScan,
    actions: ["access-analyzer:StartResourceScan"],
  }),
);
