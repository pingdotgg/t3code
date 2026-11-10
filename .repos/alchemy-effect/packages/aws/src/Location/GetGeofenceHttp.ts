import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationCollectionHttpBinding } from "./BindingHttp.ts";
import { GetGeofence } from "./GetGeofence.ts";

export const GetGeofenceHttp = Layer.effect(
  GetGeofence,
  makeLocationCollectionHttpBinding({
    tag: "AWS.Location.GetGeofence",
    operation: location.getGeofence,
    actions: ["geo:GetGeofence"],
  }),
);
