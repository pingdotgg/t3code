import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationCalculatorHttpBinding } from "./BindingHttp.ts";
import { CalculateRoute } from "./CalculateRoute.ts";

export const CalculateRouteHttp = Layer.effect(
  CalculateRoute,
  makeLocationCalculatorHttpBinding({
    tag: "AWS.Location.CalculateRoute",
    operation: location.calculateRoute,
    actions: ["geo:CalculateRoute"],
  }),
);
