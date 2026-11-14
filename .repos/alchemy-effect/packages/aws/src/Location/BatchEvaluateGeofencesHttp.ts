import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { BatchEvaluateGeofences } from "./BatchEvaluateGeofences.ts";
import { makeLocationCollectionHttpBinding } from "./BindingHttp.ts";

export const BatchEvaluateGeofencesHttp = Layer.effect(
  BatchEvaluateGeofences,
  makeLocationCollectionHttpBinding({
    tag: "AWS.Location.BatchEvaluateGeofences",
    operation: location.batchEvaluateGeofences,
    actions: ["geo:BatchEvaluateGeofences"],
  }),
);
