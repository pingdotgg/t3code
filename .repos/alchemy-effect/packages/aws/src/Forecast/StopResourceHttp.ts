import * as forecast from "@distilled.cloud/aws/forecast";
import * as Layer from "effect/Layer";
import { makeForecastHttpBinding } from "./BindingHttp.ts";
import { StopResource } from "./StopResource.ts";

export const StopResourceHttp = Layer.effect(
  StopResource,
  makeForecastHttpBinding({
    capability: "StopResource",
    iamActions: ["forecast:StopResource"],
    operation: forecast.stopResource,
  }),
);
