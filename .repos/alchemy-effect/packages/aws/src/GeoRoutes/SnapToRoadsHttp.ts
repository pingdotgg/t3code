import * as geoRoutes from "@distilled.cloud/aws/geo-routes";
import * as Layer from "effect/Layer";
import { makeGeoRoutesHttpBinding } from "./BindingHttp.ts";
import { SnapToRoads } from "./SnapToRoads.ts";

export const SnapToRoadsHttp = Layer.effect(
  SnapToRoads,
  makeGeoRoutesHttpBinding({
    capability: "SnapToRoads",
    iamActions: ["geo-routes:SnapToRoads"],
    operation: geoRoutes.snapToRoads,
  }),
);
