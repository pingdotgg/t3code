import * as forecast from "@distilled.cloud/aws/forecast";
import * as Layer from "effect/Layer";
import { makeForecastHttpBinding } from "./BindingHttp.ts";
import { DescribeDatasetImportJob } from "./DescribeDatasetImportJob.ts";

export const DescribeDatasetImportJobHttp = Layer.effect(
  DescribeDatasetImportJob,
  makeForecastHttpBinding({
    capability: "DescribeDatasetImportJob",
    iamActions: ["forecast:DescribeDatasetImportJob"],
    operation: forecast.describeDatasetImportJob,
  }),
);
