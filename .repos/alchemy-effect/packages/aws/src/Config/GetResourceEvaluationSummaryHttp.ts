import * as config from "@distilled.cloud/aws/config-service";
import * as Layer from "effect/Layer";
import { makeConfigAccountHttpBinding } from "./BindingHttp.ts";
import { GetResourceEvaluationSummary } from "./GetResourceEvaluationSummary.ts";

export const GetResourceEvaluationSummaryHttp = Layer.effect(
  GetResourceEvaluationSummary,
  makeConfigAccountHttpBinding({
    tag: "AWS.Config.GetResourceEvaluationSummary",
    operation: config.getResourceEvaluationSummary,
    actions: ["config:GetResourceEvaluationSummary"],
  }),
);
