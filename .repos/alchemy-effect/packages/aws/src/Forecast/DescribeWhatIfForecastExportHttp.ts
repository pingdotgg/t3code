import * as forecast from "@distilled.cloud/aws/forecast";
import * as Layer from "effect/Layer";
import { makeForecastHttpBinding } from "./BindingHttp.ts";
import { DescribeWhatIfForecastExport } from "./DescribeWhatIfForecastExport.ts";

export const DescribeWhatIfForecastExportHttp = Layer.effect(
  DescribeWhatIfForecastExport,
  makeForecastHttpBinding({
    capability: "DescribeWhatIfForecastExport",
    iamActions: ["forecast:DescribeWhatIfForecastExport"],
    operation: forecast.describeWhatIfForecastExport,
  }),
);
