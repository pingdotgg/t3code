import * as forecast from "@distilled.cloud/aws/forecast";
import * as Layer from "effect/Layer";
import { makeForecastHttpBinding } from "./BindingHttp.ts";
import { DescribeAutoPredictor } from "./DescribeAutoPredictor.ts";

export const DescribeAutoPredictorHttp = Layer.effect(
  DescribeAutoPredictor,
  makeForecastHttpBinding({
    capability: "DescribeAutoPredictor",
    iamActions: ["forecast:DescribeAutoPredictor"],
    operation: forecast.describeAutoPredictor,
  }),
);
