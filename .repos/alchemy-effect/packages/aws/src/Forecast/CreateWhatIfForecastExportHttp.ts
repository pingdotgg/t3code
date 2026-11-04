import * as forecast from "@distilled.cloud/aws/forecast";
import * as Layer from "effect/Layer";
import { makeForecastHttpBinding } from "./BindingHttp.ts";
import { CreateWhatIfForecastExport } from "./CreateWhatIfForecastExport.ts";

export const CreateWhatIfForecastExportHttp = Layer.effect(
  CreateWhatIfForecastExport,
  makeForecastHttpBinding({
    capability: "CreateWhatIfForecastExport",
    iamActions: ["forecast:CreateWhatIfForecastExport"],
    operation: forecast.createWhatIfForecastExport,
    // Destination hands Forecast a role to write the export to S3.
    passRole: true,
  }),
);
