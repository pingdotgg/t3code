import * as aas from "@distilled.cloud/aws/application-auto-scaling";
import * as Layer from "effect/Layer";
import { makePolicyScopedHttpBinding } from "./BindingHttp.ts";
import { GetPredictiveScalingForecast } from "./GetPredictiveScalingForecast.ts";

export const GetPredictiveScalingForecastHttp = Layer.effect(
  GetPredictiveScalingForecast,
  makePolicyScopedHttpBinding({
    tag: "AWS.ApplicationAutoScaling.GetPredictiveScalingForecast",
    operation: aas.getPredictiveScalingForecast,
    actions: ["application-autoscaling:GetPredictiveScalingForecast"],
  }),
);
