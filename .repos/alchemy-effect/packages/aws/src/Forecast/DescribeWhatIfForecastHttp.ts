import * as forecast from "@distilled.cloud/aws/forecast";
import * as Layer from "effect/Layer";
import { makeForecastHttpBinding } from "./BindingHttp.ts";
import { DescribeWhatIfForecast } from "./DescribeWhatIfForecast.ts";

export const DescribeWhatIfForecastHttp = Layer.effect(
  DescribeWhatIfForecast,
  makeForecastHttpBinding({
    capability: "DescribeWhatIfForecast",
    iamActions: ["forecast:DescribeWhatIfForecast"],
    operation: forecast.describeWhatIfForecast,
  }),
);
