import * as geoRoutes from "@distilled.cloud/aws/geo-routes";
import * as Layer from "effect/Layer";
import { makeGeoRoutesHttpBinding } from "./BindingHttp.ts";
import { CalculateRouteMatrix } from "./CalculateRouteMatrix.ts";

export const CalculateRouteMatrixHttp = Layer.effect(
  CalculateRouteMatrix,
  makeGeoRoutesHttpBinding({
    capability: "CalculateRouteMatrix",
    iamActions: ["geo-routes:CalculateRouteMatrix"],
    operation: geoRoutes.calculateRouteMatrix,
  }),
);
