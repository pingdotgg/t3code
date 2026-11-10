import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Layer from "effect/Layer";
import { makeAnalyzerScopedHttpBinding } from "./BindingHttp.ts";
import { GetFindingsStatistics } from "./GetFindingsStatistics.ts";

export const GetFindingsStatisticsHttp = Layer.effect(
  GetFindingsStatistics,
  makeAnalyzerScopedHttpBinding({
    tag: "AWS.AccessAnalyzer.GetFindingsStatistics",
    operation: aa.getFindingsStatistics,
    actions: ["access-analyzer:GetFindingsStatistics"],
  }),
);
