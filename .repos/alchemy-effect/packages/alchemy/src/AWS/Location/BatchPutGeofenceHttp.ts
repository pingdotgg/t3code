import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationCollectionHttpBinding } from "./BindingHttp.ts";
import { BatchPutGeofence } from "./BatchPutGeofence.ts";

export const BatchPutGeofenceHttp = Layer.effect(
  BatchPutGeofence,
  makeLocationCollectionHttpBinding({
    tag: "AWS.Location.BatchPutGeofence",
    operation: location.batchPutGeofence,
    actions: ["geo:BatchPutGeofence"],
  }),
);
