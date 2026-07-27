import * as geoRoutes from "@distilled.cloud/aws/geo-routes";
import * as Layer from "effect/Layer";
import { makeGeoRoutesHttpBinding } from "./BindingHttp.ts";
import { OptimizeWaypoints } from "./OptimizeWaypoints.ts";

export const OptimizeWaypointsHttp = Layer.effect(
  OptimizeWaypoints,
  makeGeoRoutesHttpBinding({
    capability: "OptimizeWaypoints",
    iamActions: ["geo-routes:OptimizeWaypoints"],
    operation: geoRoutes.optimizeWaypoints,
  }),
);
