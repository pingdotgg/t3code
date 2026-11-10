import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationCollectionHttpBinding } from "./BindingHttp.ts";
import { PutGeofence } from "./PutGeofence.ts";

export const PutGeofenceHttp = Layer.effect(
  PutGeofence,
  makeLocationCollectionHttpBinding({
    tag: "AWS.Location.PutGeofence",
    operation: location.putGeofence,
    actions: ["geo:PutGeofence"],
  }),
);
