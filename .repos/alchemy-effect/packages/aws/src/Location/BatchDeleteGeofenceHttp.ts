import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { BatchDeleteGeofence } from "./BatchDeleteGeofence.ts";
import { makeLocationCollectionHttpBinding } from "./BindingHttp.ts";

export const BatchDeleteGeofenceHttp = Layer.effect(
  BatchDeleteGeofence,
  makeLocationCollectionHttpBinding({
    tag: "AWS.Location.BatchDeleteGeofence",
    operation: location.batchDeleteGeofence,
    actions: ["geo:BatchDeleteGeofence"],
  }),
);
