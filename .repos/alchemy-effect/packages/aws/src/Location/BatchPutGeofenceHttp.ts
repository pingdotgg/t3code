import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { BatchPutGeofence } from "./BatchPutGeofence.ts";
import { makeLocationCollectionHttpBinding } from "./BindingHttp.ts";

export const BatchPutGeofenceHttp = Layer.effect(
  BatchPutGeofence,
  makeLocationCollectionHttpBinding({
    tag: "AWS.Location.BatchPutGeofence",
    operation: location.batchPutGeofence,
    actions: ["geo:BatchPutGeofence"],
  }),
);
