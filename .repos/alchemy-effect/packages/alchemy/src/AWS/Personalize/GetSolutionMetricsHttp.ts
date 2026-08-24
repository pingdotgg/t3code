import * as personalize from "@distilled.cloud/aws/personalize";
import * as Layer from "effect/Layer";
import { makePersonalizeAccountHttpBinding } from "./BindingHttp.ts";
import { GetSolutionMetrics } from "./GetSolutionMetrics.ts";

export const GetSolutionMetricsHttp = Layer.effect(
  GetSolutionMetrics,
  makePersonalizeAccountHttpBinding({
    tag: "AWS.Personalize.GetSolutionMetrics",
    operation: personalize.getSolutionMetrics,
    actions: ["personalize:GetSolutionMetrics"],
  }),
);
