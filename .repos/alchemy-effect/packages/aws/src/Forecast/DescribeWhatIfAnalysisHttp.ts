import * as forecast from "@distilled.cloud/aws/forecast";
import * as Layer from "effect/Layer";
import { makeForecastHttpBinding } from "./BindingHttp.ts";
import { DescribeWhatIfAnalysis } from "./DescribeWhatIfAnalysis.ts";

export const DescribeWhatIfAnalysisHttp = Layer.effect(
  DescribeWhatIfAnalysis,
  makeForecastHttpBinding({
    capability: "DescribeWhatIfAnalysis",
    iamActions: ["forecast:DescribeWhatIfAnalysis"],
    operation: forecast.describeWhatIfAnalysis,
  }),
);
