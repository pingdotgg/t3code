import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationCalculatorHttpBinding } from "./BindingHttp.ts";
import { CalculateRouteMatrix } from "./CalculateRouteMatrix.ts";

export const CalculateRouteMatrixHttp = Layer.effect(
  CalculateRouteMatrix,
  makeLocationCalculatorHttpBinding({
    tag: "AWS.Location.CalculateRouteMatrix",
    operation: location.calculateRouteMatrix,
    actions: ["geo:CalculateRouteMatrix"],
  }),
);
