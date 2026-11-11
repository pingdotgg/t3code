import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationCollectionHttpBinding } from "./BindingHttp.ts";
import { ForecastGeofenceEvents } from "./ForecastGeofenceEvents.ts";

export const ForecastGeofenceEventsHttp = Layer.effect(
  ForecastGeofenceEvents,
  makeLocationCollectionHttpBinding({
    tag: "AWS.Location.ForecastGeofenceEvents",
    operation: location.forecastGeofenceEvents,
    actions: ["geo:ForecastGeofenceEvents"],
  }),
);
