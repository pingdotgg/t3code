import * as forecast from "@distilled.cloud/aws/forecast";
import * as Layer from "effect/Layer";
import { makeForecastHttpBinding } from "./BindingHttp.ts";
import { DescribeForecastExportJob } from "./DescribeForecastExportJob.ts";

export const DescribeForecastExportJobHttp = Layer.effect(
  DescribeForecastExportJob,
  makeForecastHttpBinding({
    capability: "DescribeForecastExportJob",
    iamActions: ["forecast:DescribeForecastExportJob"],
    operation: forecast.describeForecastExportJob,
  }),
);
