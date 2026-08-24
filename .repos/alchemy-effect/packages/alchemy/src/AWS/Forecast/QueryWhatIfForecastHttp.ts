import * as forecastquery from "@distilled.cloud/aws/forecastquery";
import * as Layer from "effect/Layer";
import { makeForecastHttpBinding } from "./BindingHttp.ts";
import { QueryWhatIfForecast } from "./QueryWhatIfForecast.ts";

export const QueryWhatIfForecastHttp = Layer.effect(
  QueryWhatIfForecast,
  makeForecastHttpBinding({
    capability: "QueryWhatIfForecast",
    iamActions: ["forecast:QueryWhatIfForecast"],
    operation: forecastquery.queryWhatIfForecast,
  }),
);
