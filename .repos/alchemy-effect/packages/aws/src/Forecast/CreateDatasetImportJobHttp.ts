import * as forecast from "@distilled.cloud/aws/forecast";
import * as Layer from "effect/Layer";
import { makeForecastHttpBinding } from "./BindingHttp.ts";
import { CreateDatasetImportJob } from "./CreateDatasetImportJob.ts";

export const CreateDatasetImportJobHttp = Layer.effect(
  CreateDatasetImportJob,
  makeForecastHttpBinding({
    capability: "CreateDatasetImportJob",
    iamActions: ["forecast:CreateDatasetImportJob"],
    operation: forecast.createDatasetImportJob,
    passRole: true,
  }),
);
