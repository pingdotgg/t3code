import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationCollectionHttpBinding } from "./BindingHttp.ts";
import { BatchDeleteGeofence } from "./BatchDeleteGeofence.ts";

export const BatchDeleteGeofenceHttp = Layer.effect(
  BatchDeleteGeofence,
  makeLocationCollectionHttpBinding({
    tag: "AWS.Location.BatchDeleteGeofence",
    operation: location.batchDeleteGeofence,
    actions: ["geo:BatchDeleteGeofence"],
  }),
);
