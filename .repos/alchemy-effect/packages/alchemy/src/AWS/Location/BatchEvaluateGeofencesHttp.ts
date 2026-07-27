import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationCollectionHttpBinding } from "./BindingHttp.ts";
import { BatchEvaluateGeofences } from "./BatchEvaluateGeofences.ts";

export const BatchEvaluateGeofencesHttp = Layer.effect(
  BatchEvaluateGeofences,
  makeLocationCollectionHttpBinding({
    tag: "AWS.Location.BatchEvaluateGeofences",
    operation: location.batchEvaluateGeofences,
    actions: ["geo:BatchEvaluateGeofences"],
  }),
);
