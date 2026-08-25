import * as forecast from "@distilled.cloud/aws/forecast";
import * as Layer from "effect/Layer";
import { makeForecastHttpBinding } from "./BindingHttp.ts";
import { CreateWhatIfForecast } from "./CreateWhatIfForecast.ts";

export const CreateWhatIfForecastHttp = Layer.effect(
  CreateWhatIfForecast,
  makeForecastHttpBinding({
    capability: "CreateWhatIfForecast",
    iamActions: ["forecast:CreateWhatIfForecast"],
    operation: forecast.createWhatIfForecast,
    // TimeSeriesReplacementsDataSource hands Forecast a role to read S3.
    passRole: true,
  }),
);
